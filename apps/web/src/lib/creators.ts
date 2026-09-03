import "server-only";
import { z } from "zod";
import { WORK_PRIORITIES } from "@creatoros/domain";
import type { AppSession } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { appendAudit } from "@/lib/audit";
import { logEvent } from "@/lib/observability";

export const creatorPrioritySchema = z.object({
  // Nullable so a priority can be cleared back to "not triaged" rather than
  // only ever moved between levels.
  priority: z.enum(WORK_PRIORITIES).nullable(),
  // PostgREST always serializes timestamptz with a numeric offset (+00:00),
  // never a bare Z, so the token round-tripped from a GET must be accepted in
  // that form — confirmed live: a real PATCH against staging Supabase 400s
  // without { offset: true } here.
  updatedAt: z.string().datetime({ offset: true }),
});

/** A reason the caller is allowed to see. Routes return `message` verbatim. */
export class CreatorError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function databaseFailure(operation: string, error: { message: string }): CreatorError {
  logEvent("error", "creator.database_failed", { operation, message: error.message });
  return new CreatorError("CREATOR_DATABASE_FAILED", 500);
}

function admin() {
  const client = createSupabaseAdminClient();
  if (!client) throw new CreatorError("DATABASE_NOT_CONFIGURED", 503);
  return client;
}

/**
 * Sets a creator's operational priority.
 *
 * This is the first write CreatorOS has ever had against `public.creators` from
 * the UI — the creator record was read-only, so a triage decision could not be
 * recorded against the creator it was about, and nothing tied the decision to
 * the person who made it.
 *
 * Ownership comes from the session's organization, never the request, so a
 * creator id belonging to another tenant does not match and returns 404 rather
 * than disclosing that the record exists. Optimistic concurrency on
 * `updated_at` means two operators re-triaging from stale views get a refresh
 * prompt instead of one silently overwriting the other.
 */
export async function updateCreatorPriority(
  session: AppSession,
  creatorId: string,
  input: z.infer<typeof creatorPrioritySchema>,
) {
  const client = admin();
  const current = await client
    .from("creators")
    .select("id,priority,updated_at,stage_name")
    .eq("organization_id", session.organizationId)
    .eq("id", creatorId)
    .maybeSingle();
  if (current.error) throw databaseFailure("read-current", current.error);
  if (!current.data) throw new CreatorError("CREATOR_NOT_FOUND", 404);
  const before = current.data as {
    priority: string | null;
    updated_at: string;
    stage_name: string;
  };
  if (before.updated_at !== input.updatedAt)
    throw new CreatorError("CREATOR_CHANGED_REFRESH_REQUIRED", 409);

  const updatedAt = new Date().toISOString();
  const { data, error } = await client
    .from("creators")
    .update({
      priority: input.priority,
      updated_at: updatedAt,
      // Who last touched the record, for the creator page's own display.
      updated_by: session.userId,
    })
    .eq("organization_id", session.organizationId)
    .eq("id", creatorId)
    .eq("updated_at", input.updatedAt)
    .select("id,priority")
    .maybeSingle();
  if (error) throw databaseFailure("write", error);
  if (!data) throw new CreatorError("CREATOR_CHANGED_REFRESH_REQUIRED", 409);

  /**
   * The priority change above already committed — appendAudit is a second,
   * independent write. Letting its failure propagate would make the caller see
   * a 500 and conclude nothing happened, when the record was in fact already
   * changed: a worse outcome than the audit gap itself; the caller could retry
   * a write that already applied, or believe the priority is still untriaged
   * when someone has, in fact, acted on it. So a failure here is logged loudly
   * — it is the one way this specific change could go unattributed — and the
   * caller still gets the success it actually got.
   */
  try {
    await appendAudit(session, "creator.priority.changed", "creator", creatorId, {
      stageName: before.stage_name,
      before: before.priority,
      after: input.priority,
    });
  } catch (auditError) {
    logEvent("error", "creator.priority.audit_failed", {
      creatorId,
      userId: session.userId,
      message: auditError instanceof Error ? auditError.message : String(auditError),
    });
  }
  return { id: creatorId, priority: input.priority, updatedAt };
}
