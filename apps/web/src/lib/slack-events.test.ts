import { describe, expect, it } from "vitest";
import {
  isSelfAuthoredEvent,
  shouldProcessEvent,
  slackEventCallbackSchema,
  slackUrlVerificationSchema,
  stripMention,
  type SlackEventCallback,
} from "./slack-events";

const BOT_USER_ID = "U0BOTBOT";

function callback(event: Partial<SlackEventCallback["event"]>): SlackEventCallback {
  return {
    type: "event_callback",
    team_id: "T123",
    event_id: "Ev123",
    event: { type: "app_mention", user: "U0HUMAN", text: "<@U0BOTBOT> status?", ...event },
  };
}

describe("Slack event payload parsing", () => {
  it("recognises the url_verification handshake", () => {
    const parsed = slackUrlVerificationSchema.safeParse({
      type: "url_verification",
      challenge: "3eZbrw1a",
    });
    expect(parsed.success && parsed.data.challenge).toBe("3eZbrw1a");
  });

  it("rejects an event callback missing the fields dedupe depends on", () => {
    expect(
      slackEventCallbackSchema.safeParse({ type: "event_callback", event: { type: "app_mention" } })
        .success,
    ).toBe(false);
  });
});

describe("bot recursion protection", () => {
  it("treats a message carrying bot_id as self-authored", () => {
    expect(isSelfAuthoredEvent(callback({ bot_id: "B123" }), BOT_USER_ID)).toBe(true);
  });

  it("treats the bot_message subtype as self-authored", () => {
    expect(isSelfAuthoredEvent(callback({ subtype: "bot_message" }), BOT_USER_ID)).toBe(true);
  });

  it("treats a message from the app's own user id as self-authored", () => {
    expect(isSelfAuthoredEvent(callback({ user: BOT_USER_ID }), BOT_USER_ID)).toBe(true);
  });

  it("does not treat a human message as self-authored", () => {
    expect(isSelfAuthoredEvent(callback({ user: "U0HUMAN" }), BOT_USER_ID)).toBe(false);
  });

  it("refuses to process anything self-authored, closing the reply loop", () => {
    expect(shouldProcessEvent(callback({ bot_id: "B123" }), BOT_USER_ID)).toEqual({
      process: false,
      reason: "SELF_AUTHORED",
    });
  });
});

describe("which events the agent acts on", () => {
  it("processes an app_mention from a human and returns the stripped prompt", () => {
    expect(shouldProcessEvent(callback({}), BOT_USER_ID)).toEqual({
      process: true,
      prompt: "status?",
    });
  });

  it("processes a direct message", () => {
    expect(
      shouldProcessEvent(
        callback({ type: "message", channel_type: "im", text: "how is Madison?" }),
        BOT_USER_ID,
      ),
    ).toEqual({ process: true, prompt: "how is Madison?" });
  });

  it("answers a DM that also mentions the bot exactly once", () => {
    // Slack delivers such a message twice — once as app_mention, once as
    // message.im — with different event_ids, so the delivery ledger cannot
    // collapse them and the agent would reply twice.
    const text = "<@U0BOTBOT> what is the buffer?";
    expect(
      shouldProcessEvent(callback({ type: "message", channel_type: "im", text }), BOT_USER_ID),
    ).toEqual({ process: false, reason: "DUPLICATE_OF_APP_MENTION" });
    expect(shouldProcessEvent(callback({ type: "app_mention", text }), BOT_USER_ID)).toEqual({
      process: true,
      prompt: "what is the buffer?",
    });
  });

  it("skips a bare mention with nothing after it", () => {
    // Non-empty as raw text, empty once the mention is stripped. Enqueueing it
    // only to fail schema validation downstream tells nobody anything.
    expect(shouldProcessEvent(callback({ text: "<@U0BOTBOT>" }), BOT_USER_ID)).toEqual({
      process: false,
      reason: "EMPTY_AFTER_MENTION_STRIP",
    });
  });

  it("truncates an oversized prompt rather than rejecting it downstream", () => {
    const decision = shouldProcessEvent(
      callback({ type: "message", channel_type: "im", text: "x".repeat(9000) }),
      BOT_USER_ID,
    );
    expect(decision.process).toBe(true);
    expect(decision.process === true && decision.prompt.length).toBe(4000);
  });

  it("ignores an ordinary channel message that does not mention the agent", () => {
    expect(
      shouldProcessEvent(
        callback({ type: "message", channel_type: "channel", text: "unrelated chatter" }),
        BOT_USER_ID,
      ),
    ).toEqual({ process: false, reason: "CHANNEL_MESSAGE_WITHOUT_MENTION" });
  });

  it("ignores event types the agent does not handle", () => {
    expect(shouldProcessEvent(callback({ type: "reaction_added" }), BOT_USER_ID)).toEqual({
      process: false,
      reason: "UNHANDLED_EVENT_TYPE:reaction_added",
    });
  });

  it("ignores an event with no human author or no text", () => {
    expect(shouldProcessEvent(callback({ user: undefined }), BOT_USER_ID)).toEqual({
      process: false,
      reason: "NO_HUMAN_AUTHOR",
    });
    expect(shouldProcessEvent(callback({ text: "   " }), BOT_USER_ID)).toEqual({
      process: false,
      reason: "EMPTY_AFTER_MENTION_STRIP",
    });
  });
});

describe("mention stripping", () => {
  it("removes mention tokens and normalises whitespace", () => {
    expect(stripMention("<@U0BOTBOT>   what needs   my attention today?")).toBe(
      "what needs my attention today?",
    );
  });

  it("removes mentions that appear mid-sentence", () => {
    expect(stripMention("hey <@U0BOTBOT> how is <@U0OTHER> doing")).toBe("hey how is doing");
  });

  it("removes Slack's labelled mention form", () => {
    // Link-formatted payloads carry <@U123|display-name>; the unlabelled-only
    // pattern left that markup in the prompt the model receives.
    expect(stripMention("<@U0BOTBOT|foundry> what is the buffer?")).toBe("what is the buffer?");
    expect(stripMention("ask <@U0OTHER|jane.doe> about it")).toBe("ask about it");
  });
});
