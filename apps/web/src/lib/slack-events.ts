import "server-only";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const slackUrlVerificationSchema = z.object({
  type: z.literal("url_verification"),
  challenge: z.string().min(1).max(1000),
});

const innerEventSchema = z.object({
  type: z.string(),
  user: z.string().optional(),
  text: z.string().optional(),
  channel: z.string().optional(),
  channel_type: z.string().optional(),
  ts: z.string().optional(),
  thread_ts: z.string().optional(),
  bot_id: z.string().optional(),
  subtype: z.string().optional(),
  app_id: z.string().optional(),
});

export const slackEventCallbackSchema = z.object({
  type: z.literal("event_callback"),
  team_id: z.string().min(1),
  api_app_id: z.string().optional(),
  event_id: z.string().min(1),
  event_time: z.number().optional(),
  authorizations: z
    .array(z.object({ user_id: z.string().optional(), is_bot: z.boolean().optional() }))
    .optional(),
  event: innerEventSchema,
});

export type SlackEventCallback = z.infer<typeof slackEventCallbackSchema>;

/** Events the Foundry agent acts on. Everything else is acknowledged and dropped. */
export const HANDLED_EVENT_TYPES = ["app_mention", "message"] as const;

/**
 * A bot must never answer itself. Slack delivers the agent's own replies back to
 * the app, so without this an @mention answered in-channel becomes an infinite
 * loop of the agent replying to its own message.
 */
export function isSelfAuthoredEvent(
  payload: SlackEventCallback,
  botUserId: string | null,
): boolean {
  const event = payload.event;
  if (event.bot_id) return true;
  if (event.subtype === "bot_message") return true;
  if (botUserId && event.user === botUserId) return true;
  return false;
}

export function shouldProcessEvent(
  payload: SlackEventCallback,
  botUserId: string | null,
): { process: false; reason: string } | { process: true } {
  const event = payload.event;
  if (!HANDLED_EVENT_TYPES.includes(event.type as (typeof HANDLED_EVENT_TYPES)[number]))
    return { process: false, reason: `UNHANDLED_EVENT_TYPE:${event.type}` };
  if (isSelfAuthoredEvent(payload, botUserId)) return { process: false, reason: "SELF_AUTHORED" };
  if (!event.user) return { process: false, reason: "NO_HUMAN_AUTHOR" };
  // Plain channel messages are noise; only direct messages and explicit mentions
  // are addressed to the agent.
  if (event.type === "message" && event.channel_type !== "im")
    return { process: false, reason: "CHANNEL_MESSAGE_WITHOUT_MENTION" };
  if (!event.text?.trim()) return { process: false, reason: "EMPTY_TEXT" };
  return { process: true };
}

/** Strips the leading `<@U123>` mention so the model sees the actual question. */
export function stripMention(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const connectionSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  capabilities_json: z.record(z.string(), z.unknown()).nullable(),
});

/**
 * Resolves the Slack workspace to a CreatorOS tenant through the installed
 * connection. A workspace with no CONNECTED installation resolves to nothing,
 * so events from unknown workspaces are dropped rather than defaulting to any
 * organization.
 */
export async function resolveSlackWorkspace(slackTeamId: string): Promise<{
  organizationId: string;
  connectionId: string;
  botUserId: string | null;
} | null> {
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("integration_connections")
    .select("id,organization_id,capabilities_json")
    .eq("provider", "SLACK")
    .eq("external_account_id", slackTeamId)
    .is("creator_id", null)
    .eq("status", "CONNECTED")
    .maybeSingle();
  const parsed = connectionSchema.safeParse(data);
  if (error || !parsed.success) return null;
  const botUserId = parsed.data.capabilities_json?.["botUserId"];
  return {
    organizationId: parsed.data.organization_id,
    connectionId: parsed.data.id,
    botUserId: typeof botUserId === "string" ? botUserId : null,
  };
}

/**
 * Claims an event for processing. Returns false when Slack has already
 * delivered this event id, which is the guard against the agent answering the
 * same mention twice after a Slack retry.
 */
export async function claimSlackEvent(input: {
  slackTeamId: string;
  slackEventId: string;
  eventType: string;
  organizationId: string | null;
  channelId: string | null;
  slackUserId: string | null;
}): Promise<boolean> {
  const admin = createSupabaseAdminClient();
  if (!admin) return false;
  const { data, error } = await admin.rpc("claim_slack_event", {
    p_slack_team_id: input.slackTeamId,
    p_slack_event_id: input.slackEventId,
    p_event_type: input.eventType,
    p_organization_id: input.organizationId,
    p_channel_id: input.channelId,
    p_slack_user_id: input.slackUserId,
  });
  if (error) throw new Error(`SLACK_EVENT_CLAIM_FAILED: ${error.message}`);
  return data === true;
}

/**
 * Releases a claim so Slack's retry can process the event after all.
 *
 * Claiming happens before the work is enqueued, which is what makes retries
 * safe. But if the enqueue then fails, the claim would deduplicate every retry
 * and the mention would be lost forever with no error surfaced to anyone.
 * Releasing restores the pre-claim state so the next delivery is treated as new.
 */
export async function releaseSlackEvent(input: {
  slackTeamId: string;
  slackEventId: string;
}): Promise<void> {
  const admin = createSupabaseAdminClient();
  if (!admin) return;
  await admin
    .from("slack_event_deliveries")
    .delete()
    .eq("slack_team_id", input.slackTeamId)
    .eq("slack_event_id", input.slackEventId);
}

/** Records that an event reached the queue, for after-the-fact diagnosis. */
export async function markSlackEventQueued(input: {
  slackTeamId: string;
  slackEventId: string;
  status: string;
}): Promise<void> {
  const admin = createSupabaseAdminClient();
  if (!admin) return;
  await admin
    .from("slack_event_deliveries")
    .update({ status: input.status, processed_at: new Date().toISOString() })
    .eq("slack_team_id", input.slackTeamId)
    .eq("slack_event_id", input.slackEventId);
}

const identitySchema = z.object({ user_id: z.string().uuid(), active: z.boolean() });

/**
 * Maps a Slack user to a CreatorOS identity. An unmapped Slack user gets no
 * identity and therefore no tool access at all: Slack membership is not
 * CreatorOS authorization.
 */
export async function resolveSlackIdentity(input: {
  slackTeamId: string;
  slackUserId: string;
  organizationId: string;
}): Promise<{ userId: string } | null> {
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("slack_user_identities")
    .select("user_id,active")
    .eq("slack_team_id", input.slackTeamId)
    .eq("slack_user_id", input.slackUserId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  const parsed = identitySchema.safeParse(data);
  if (error || !parsed.success || !parsed.data.active) return null;
  return { userId: parsed.data.user_id };
}
