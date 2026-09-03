import "server-only";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * Posts into a Slack thread. The shared SlackProvider interface deliberately has
 * no thread concept — it provisions channels — so replies use chat.postMessage
 * directly rather than widening that contract for one caller.
 */
export async function postSlackReply(input: {
  token: string;
  channel: string;
  text: string;
  threadTs?: string | null;
}): Promise<void> {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: input.channel,
      text: input.text,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    }),
  });
  const data = (await response.json()) as { ok?: boolean; error?: string };
  // Never include the token or the message body in the error: this string is logged.
  if (!response.ok || !data.ok)
    throw new Error(`SLACK_POST_FAILED: ${data.error ?? response.status}`);
}

const resourceSchema = z.object({ idempotency_key: z.string() });

/**
 * Decides whether a surface must be treated as readable by a creator.
 *
 * This fails CLOSED. An earlier version returned false — internal — for any
 * channel with no provisioning record, which is every channel Foundry creates
 * by hand, including ones a creator has been invited to. That contradicted the
 * intent and would have let P&L-adjacent internal tools answer in a channel a
 * creator can read.
 *
 * A direct message is the one surface that is positively known to be internal:
 * it is one-to-one with a Foundry employee who is mapped in
 * slack_user_identities. Everything else is creator-facing unless the
 * provisioning ledger says it is the internal channel for a creator.
 */
export async function isCreatorFacingChannel(
  organizationId: string,
  channelId: string,
  options: { isDirectMessage?: boolean } = {},
): Promise<boolean> {
  if (options.isDirectMessage) return false;
  const admin = createSupabaseAdminClient();
  if (!admin) return true;
  const { data, error } = await admin
    .from("provisioned_resources")
    .select("idempotency_key")
    .eq("organization_id", organizationId)
    .eq("provider", "SLACK")
    .eq("external_id", channelId)
    .maybeSingle();
  if (error) return true;
  const parsed = resourceSchema.safeParse(data);
  // Unknown channel: treat as creator-readable. Guessing wrong the other way
  // discloses Foundry internals to a creator.
  if (!parsed.success) return true;
  // Only a channel provisioned as the *internal* channel is known-internal.
  return !parsed.data.idempotency_key.includes(":slack:internal-channel");
}
