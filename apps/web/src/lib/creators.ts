import "server-only";
import { z } from "zod";
import {
  ADULT_CONFIRMATION_STATUSES,
  JURISDICTION_REVIEW_STATUSES,
  WORK_PRIORITIES,
} from "@creatoros/domain";
import type { AppSession } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { appendAudit } from "@/lib/audit";
import { logEvent } from "@/lib/observability";

/**
 * Records the two human-authority decisions activation blocks on.
 *
 * Both fields are optional so a reviewer can record one decision without
 * asserting the other, but the route refuses a body carrying neither — an
 * empty patch would burn the concurrency token for no change.
 */
export const creatorComplianceSchema = z
  .object({
    jurisdictionReviewStatus: z.enum(JURISDICTION_REVIEW_STATUSES).optional(),
    adultConfirmationStatus: z.enum(ADULT_CONFIRMATION_STATUSES).optional(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .refine(
    (value) =>
      value.jurisdictionReviewStatus !== undefined || value.adultConfirmationStatus !== undefined,
    { message: "NO_COMPLIANCE_FIELDS_TO_UPDATE" },
  );

/**
 * Assigns the Foundry owners of a creator.
 *
 * Nullable so an owner can be cleared, and both optional so one seat can be
 * filled without touching the other. Readiness is satisfied by either seat
 * being filled (activation-readiness.ts's `assigned-team` check), which is why
 * this is one write rather than two independent ones.
 */
export const creatorAssignmentSchema = z
  .object({
    creatorSuccessUserId: z.string().uuid().nullable().optional(),
    growthUserId: z.string().uuid().nullable().optional(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .refine(
    (value) => value.creatorSuccessUserId !== undefined || value.growthUserId !== undefined,
    { message: "NO_ASSIGNMENT_FIELDS_TO_UPDATE" },
  );

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

  const { data, error } = await client
    .from("creators")
    .update({
      priority: input.priority,
      updated_at: new Date().toISOString(),
      // Who last touched the record, for the creator page's own display.
      updated_by: session.userId,
    })
    .eq("organization_id", session.organizationId)
    .eq("id", creatorId)
    .eq("updated_at", input.updatedAt)
    // Same reason as patchCreator: return the stored timestamptz, not the
    // string we sent, or the caller's next token can never match.
    .select("id,priority,updated_at")
    .maybeSingle();
  if (error) throw databaseFailure("write", error);
  if (!data) throw new CreatorError("CREATOR_CHANGED_REFRESH_REQUIRED", 409);
  const writtenPriority = z.object({ updated_at: z.string() }).safeParse(data);
  const updatedAt = writtenPriority.success ? writtenPriority.data.updated_at : input.updatedAt;

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

/**
 * Applies a patch to a creator row under optimistic concurrency, then audits it.
 *
 * Shared by the compliance and assignment writers because the dance is
 * identical and easy to get subtly wrong in only one of them: read current,
 * refuse a stale token, re-assert the token in the UPDATE's WHERE clause so a
 * writer that slipped in between the read and the write loses, and audit
 * best-effort afterwards so a failed audit cannot turn a committed change into
 * a 500 the caller reads as "nothing happened".
 */
async function patchCreator(
  session: AppSession,
  creatorId: string,
  input: { updatedAt: string },
  patch: Record<string, string | null>,
  audit: { action: string; before: Record<string, unknown> },
): Promise<{ id: string; updatedAt: string }> {
  const client = admin();
  const current = await client
    .from("creators")
    .select("id,updated_at,stage_name")
    .eq("organization_id", session.organizationId)
    .eq("id", creatorId)
    .maybeSingle();
  if (current.error) throw databaseFailure("read-current", current.error);
  if (!current.data) throw new CreatorError("CREATOR_NOT_FOUND", 404);
  const before = current.data as { updated_at: string; stage_name: string };
  if (before.updated_at !== input.updatedAt)
    throw new CreatorError("CREATOR_CHANGED_REFRESH_REQUIRED", 409);

  const { data, error } = await client
    .from("creators")
    .update({ ...patch, updated_at: new Date().toISOString(), updated_by: session.userId })
    .eq("organization_id", session.organizationId)
    .eq("id", creatorId)
    .eq("updated_at", input.updatedAt)
    // Read the stored value back rather than returning the string we sent.
    // Postgres reports timestamptz with a numeric offset and microsecond
    // precision (`...312503+00:00`); `new Date().toISOString()` produces
    // `...312Z`. Returning the latter hands the caller a token that can never
    // match the next read, so a second consecutive edit always 409s.
    .select("id,updated_at")
    .maybeSingle();
  if (error) throw databaseFailure("write", error);
  if (!data) throw new CreatorError("CREATOR_CHANGED_REFRESH_REQUIRED", 409);
  const written = z
    .object({ updated_at: z.string() })
    .safeParse(data);
  const updatedAt = written.success ? written.data.updated_at : input.updatedAt;

  try {
    await appendAudit(session, audit.action, "creator", creatorId, {
      stageName: before.stage_name,
      ...audit.before,
      after: patch,
    });
  } catch (auditError) {
    logEvent("error", "creator.audit_failed", {
      action: audit.action,
      creatorId,
      userId: session.userId,
      message: auditError instanceof Error ? auditError.message : String(auditError),
    });
  }
  return { id: creatorId, updatedAt };
}

/**
 * Records a jurisdiction review and/or adult confirmation decision.
 *
 * These are two of the four BLOCKED activation gates that previously had no
 * write path at any layer: the conversion RPC hardcodes PENDING/NOT_STARTED
 * and nothing could ever change them, so no converted creator could reach
 * ACTIVE. Requires `creator.update` at the route.
 */
export async function updateCreatorCompliance(
  session: AppSession,
  creatorId: string,
  input: z.infer<typeof creatorComplianceSchema>,
) {
  const patch: Record<string, string | null> = {};
  if (input.jurisdictionReviewStatus !== undefined)
    patch["jurisdiction_review_status"] = input.jurisdictionReviewStatus;
  if (input.adultConfirmationStatus !== undefined)
    patch["adult_confirmation_status"] = input.adultConfirmationStatus;

  const result = await patchCreator(session, creatorId, input, patch, {
    action: "creator.compliance.recorded",
    before: {},
  });
  return { ...result, ...input, updatedAt: result.updatedAt };
}

/**
 * Assigns or clears the Foundry owners of a creator.
 *
 * The third BLOCKED gate with no previous writer. `assigned-team` is satisfied
 * by either seat, and activation re-checks it at execution time, so leaving
 * both empty is what kept every converted creator un-activatable.
 */
export async function updateCreatorAssignment(
  session: AppSession,
  creatorId: string,
  input: z.infer<typeof creatorAssignmentSchema>,
) {
  const patch: Record<string, string | null> = {};
  if (input.creatorSuccessUserId !== undefined)
    patch["assigned_creator_success_user_id"] = input.creatorSuccessUserId;
  if (input.growthUserId !== undefined) patch["assigned_growth_user_id"] = input.growthUserId;

  const result = await patchCreator(session, creatorId, input, patch, {
    action: "creator.assignment.changed",
    before: {},
  });
  return { ...result, ...input, updatedAt: result.updatedAt };
}
