import { describe, expect, it } from "vitest";
import {
  signSlackRequest,
  verifySlackRequest,
  SLACK_REPLAY_WINDOW_SECONDS,
} from "./slack-signature";

const signingSecret = "8f742231b10e8888abcd99yyyzzz85a5";
const rawBody = JSON.stringify({
  type: "event_callback",
  event: { type: "app_mention", text: "<@U123> what needs my attention today?" },
});
const now = 1_757_000_000;
const timestamp = String(now);
const signature = signSlackRequest({ signingSecret, timestamp, rawBody });

describe("Slack request signature verification", () => {
  it("accepts a correctly signed, fresh request", () => {
    expect(
      verifySlackRequest({ signingSecret, signature, timestamp, rawBody, nowSeconds: now }),
    ).toEqual({ valid: true });
  });

  it("rejects a request with no signature or no timestamp", () => {
    expect(
      verifySlackRequest({ signingSecret, signature: null, timestamp, rawBody, nowSeconds: now }),
    ).toEqual({ valid: false, reason: "MISSING_SIGNATURE" });
    expect(
      verifySlackRequest({ signingSecret, signature, timestamp: null, rawBody, nowSeconds: now }),
    ).toEqual({ valid: false, reason: "MISSING_TIMESTAMP" });
  });

  it("rejects a replayed request outside the five minute window", () => {
    expect(
      verifySlackRequest({
        signingSecret,
        signature,
        timestamp,
        rawBody,
        nowSeconds: now + SLACK_REPLAY_WINDOW_SECONDS + 1,
      }),
    ).toEqual({ valid: false, reason: "TIMESTAMP_OUT_OF_RANGE" });
  });

  it("rejects a timestamp from the future, not just a stale one", () => {
    expect(
      verifySlackRequest({
        signingSecret,
        signature,
        timestamp,
        rawBody,
        nowSeconds: now - SLACK_REPLAY_WINDOW_SECONDS - 1,
      }),
    ).toEqual({ valid: false, reason: "TIMESTAMP_OUT_OF_RANGE" });
  });

  it("accepts a request at the exact edge of the window", () => {
    expect(
      verifySlackRequest({
        signingSecret,
        signature,
        timestamp,
        rawBody,
        nowSeconds: now + SLACK_REPLAY_WINDOW_SECONDS,
      }),
    ).toEqual({ valid: true });
  });

  it("rejects a body altered after signing", () => {
    const tampered = rawBody.replace("what needs my attention today?", "delete everything");
    expect(
      verifySlackRequest({
        signingSecret,
        signature,
        timestamp,
        rawBody: tampered,
        nowSeconds: now,
      }),
    ).toEqual({ valid: false, reason: "SIGNATURE_MISMATCH" });
  });

  it("rejects a signature produced with a different signing secret", () => {
    const forged = signSlackRequest({ signingSecret: "attacker-secret", timestamp, rawBody });
    expect(
      verifySlackRequest({
        signingSecret,
        signature: forged,
        timestamp,
        rawBody,
        nowSeconds: now,
      }),
    ).toEqual({ valid: false, reason: "SIGNATURE_MISMATCH" });
  });

  it("rejects a signature bound to a different timestamp", () => {
    const otherTimestamp = String(now - 60);
    const boundElsewhere = signSlackRequest({
      signingSecret,
      timestamp: otherTimestamp,
      rawBody,
    });
    expect(
      verifySlackRequest({
        signingSecret,
        signature: boundElsewhere,
        timestamp,
        rawBody,
        nowSeconds: now,
      }),
    ).toEqual({ valid: false, reason: "SIGNATURE_MISMATCH" });
  });

  it("rejects malformed timestamps and unsupported signature versions", () => {
    expect(
      verifySlackRequest({
        signingSecret,
        signature,
        timestamp: "not-a-number",
        rawBody,
        nowSeconds: now,
      }),
    ).toEqual({ valid: false, reason: "MALFORMED_TIMESTAMP" });
    expect(
      verifySlackRequest({
        signingSecret,
        signature: signature.replace("v0=", "v1="),
        timestamp,
        rawBody,
        nowSeconds: now,
      }),
    ).toEqual({ valid: false, reason: "UNSUPPORTED_VERSION" });
  });

  it("rejects a truncated signature without throwing on buffer length", () => {
    expect(
      verifySlackRequest({
        signingSecret,
        signature: signature.slice(0, 20),
        timestamp,
        rawBody,
        nowSeconds: now,
      }),
    ).toEqual({ valid: false, reason: "SIGNATURE_MISMATCH" });
  });

  it("is sensitive to byte-exact bodies, so parsed-and-reserialised JSON fails", () => {
    const reserialised = JSON.stringify(JSON.parse(rawBody), null, 2);
    expect(
      verifySlackRequest({
        signingSecret,
        signature,
        timestamp,
        rawBody: reserialised,
        nowSeconds: now,
      }),
    ).toEqual({ valid: false, reason: "SIGNATURE_MISMATCH" });
  });
});
