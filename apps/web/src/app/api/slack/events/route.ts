import { NextResponse } from "next/server";
import { getEnvironment } from "@/lib/environment";
import { inngest } from "@/lib/inngest";
import { getCorrelationId, logEvent } from "@/lib/observability";
import { verifySlackRequest } from "@/lib/slack-signature";
import {
  claimSlackEvent,
  resolveSlackWorkspace,
  shouldProcessEvent,
  markSlackEventQueued,
  releaseSlackEvent,
  slackEventCallbackSchema,
  slackUrlVerificationSchema,
  stripMention,
} from "@/lib/slack-events";

/**
 * Slack's events ingress.
 *
 * Slack retries any request it does not get a 2xx for within three seconds, so
 * this handler does only the cheap, safe work — verify, deduplicate, enqueue —
 * and hands the actual agent turn to Inngest. Answering inline would guarantee
 * timeouts and duplicate replies as soon as the model takes longer than three
 * seconds, which it always does.
 *
 * This route is deliberately excluded from the auth proxy: Slack authenticates
 * with a request signature, not a session cookie.
 */
export async function POST(request: Request) {
  const correlationId = getCorrelationId(request);
  const environment = getEnvironment();
  const signingSecret = environment.SLACK_SIGNING_SECRET;

  // Byte-exact body. Parsing first and re-serialising would change key order and
  // whitespace, and the signature would never match.
  const rawBody = await request.text();

  if (!signingSecret) {
    logEvent("error", "slack.events.not_configured", { correlationId });
    return NextResponse.json({ error: "SLACK_NOT_CONFIGURED" }, { status: 503 });
  }

  const verification = verifySlackRequest({
    signingSecret,
    signature: request.headers.get("x-slack-signature"),
    timestamp: request.headers.get("x-slack-request-timestamp"),
    rawBody,
  });
  if (!verification.valid) {
    logEvent("warn", "slack.events.rejected", { correlationId, reason: verification.reason });
    // 401 for everything: never reveal which check failed.
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  // Slack sends this once when the endpoint is registered. It is still signed,
  // so it is handled only after verification.
  const challenge = slackUrlVerificationSchema.safeParse(payload);
  if (challenge.success) {
    logEvent("info", "slack.events.url_verified", { correlationId });
    return NextResponse.json({ challenge: challenge.data.challenge });
  }

  const parsed = slackEventCallbackSchema.safeParse(payload);
  if (!parsed.success) {
    // Acknowledge anything we do not model, so Slack stops retrying it.
    logEvent("info", "slack.events.ignored_shape", { correlationId });
    return NextResponse.json({ ok: true });
  }
  const event = parsed.data;

  const workspace = await resolveSlackWorkspace(event.team_id);
  if (!workspace) {
    logEvent("warn", "slack.events.unknown_workspace", {
      correlationId,
      slackTeamId: event.team_id,
    });
    return NextResponse.json({ ok: true });
  }

  const decision = shouldProcessEvent(event, workspace.botUserId);

  // Claim before deciding to act, so retries of ignored events are cheap and a
  // retry of a handled event can never produce a second answer.
  let claimed: boolean;
  try {
    claimed = await claimSlackEvent({
      slackTeamId: event.team_id,
      slackEventId: event.event_id,
      eventType: event.event.type,
      organizationId: workspace.organizationId,
      channelId: event.event.channel ?? null,
      slackUserId: event.event.user ?? null,
    });
  } catch (error) {
    logEvent("error", "slack.events.claim_failed", {
      correlationId,
      error: error instanceof Error ? error.message : "UNKNOWN",
    });
    // Let Slack retry: the claim is what makes retries safe.
    return NextResponse.json({ error: "CLAIM_FAILED" }, { status: 500 });
  }
  if (!claimed) {
    logEvent("info", "slack.events.duplicate", { correlationId, slackEventId: event.event_id });
    return NextResponse.json({ ok: true, duplicate: true });
  }

  if (!decision.process) {
    logEvent("info", "slack.events.skipped", { correlationId, reason: decision.reason });
    return NextResponse.json({ ok: true, skipped: decision.reason });
  }

  try {
    await inngest.send({
      id: `slack:${event.team_id}:${event.event_id}`,
      name: "slack.agent.requested",
      data: {
        organizationId: workspace.organizationId,
        slackTeamId: event.team_id,
        slackEventId: event.event_id,
        slackUserId: event.event.user,
        channelId: event.event.channel,
        threadTs: event.event.thread_ts ?? event.event.ts,
        prompt: stripMention(event.event.text ?? ""),
        correlationId,
      },
    });
  } catch (error) {
    // The claim is already held, so without releasing it every Slack retry
    // would be deduplicated and this mention would be lost permanently with no
    // error visible to the person who sent it.
    await releaseSlackEvent({
      slackTeamId: event.team_id,
      slackEventId: event.event_id,
    }).catch(() => undefined);
    logEvent("error", "slack.events.enqueue_failed", {
      correlationId,
      slackEventId: event.event_id,
      error: error instanceof Error ? error.message : "UNKNOWN",
    });
    return NextResponse.json({ error: "ENQUEUE_FAILED" }, { status: 500 });
  }

  await markSlackEventQueued({
    slackTeamId: event.team_id,
    slackEventId: event.event_id,
    status: "QUEUED",
  }).catch(() => undefined);
  logEvent("info", "slack.events.queued", {
    correlationId,
    organizationId: workspace.organizationId,
    slackEventId: event.event_id,
    eventType: event.event.type,
  });
  return NextResponse.json({ ok: true });
}
