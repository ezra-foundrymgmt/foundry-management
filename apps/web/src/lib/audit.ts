import "server-only";
import type { AppSession } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * Appends to the immutable audit trail.
 *
 * `audit_events` is append-only in the database: UPDATE and DELETE raise from a
 * trigger and TRUNCATE is blocked by a statement-level trigger, so nothing —
 * including something holding the service role — can edit a past entry to hide
 * a change. The actor always comes from the session, never from a request.
 */
export async function appendAudit(
  session: AppSession,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const client = createSupabaseAdminClient();
  if (!client) throw new Error("DATABASE_NOT_CONFIGURED");
  const { error } = await client.from("audit_events").insert({
    organization_id: session.organizationId,
    actor_type: "user",
    actor_user_id: session.userId,
    action,
    resource_type: resourceType,
    resource_id: resourceId,
    metadata_json: metadata,
    correlation_id: crypto.randomUUID(),
  });
  if (error) throw new Error(`AUDIT_APPEND_FAILED: ${error.message}`);
}
