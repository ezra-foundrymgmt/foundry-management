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
 * A channel is creator-facing when activation provisioned it as the creator
 * channel. Anything we cannot positively identify as internal is treated as
 * creator-facing, because the cost of guessing wrong is disclosing Foundry
 * internals to a creator.
 */
export async function isCreatorFacingChannel(
  organizationId: string,
  channelId: string,
): Promise<boolean> {
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
  // No provisioning record: an ordinary internal Foundry channel or a DM.
  if (!parsed.success) return false;
  return parsed.data.idempotency_key.includes(":slack:creator-channel");
}
