import "server-only";
import { z } from "zod";
import { BOUNDARY_SEVERITIES, BOUNDARY_TYPES } from "@creatoros/domain";
import type { AppSession } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { appendAudit } from "@/lib/audit";
import { logEvent } from "@/lib/observability";

/**
 * What a creator will and will not do, recorded against the creator it is about.
 *
 * `creator_boundaries` existed from the first migration and was read in three
 * places -- including a BLOCKED activation gate and a re-check at workflow
 * execution time -- but nothing in the codebase could write it. A creator
 * converted from a prospect therefore could not be activated through any
 * supported path; the gate could only be cleared with direct SQL.
 *
 * Boundaries are also the substrate every creator-facing decision is supposed
 * to be checked against, so this being empty was not merely a blocked
 * workflow: it meant the operating record carried no statement of a creator's
 * limits at all.
 */
export const boundaryCreateSchema = z.object({
  boundaryType: z.enum(BOUNDARY_TYPES),
  description: z.string().trim().min(1).max(2000),
  severity: z.enum(BOUNDARY_SEVERITIES),
  // Only meaningful for a SOFT boundary -- a hard limit is not something the
  // creator gets asked about again -- but stored as given so the record
  // reflects what the operator actually asserted.
  requiresCreatorApproval: z.boolean().default(false),
  source: z.string().trim().max(120).optional(),
});

/** A reason the caller is allowed to see. Routes return `message` verbatim. */
export class BoundaryError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function databaseFailure(operation: string, error: { message: string }): BoundaryError {
  logEvent("error", "boundary.database_failed", { operation, message: error.message });
  return new BoundaryError("BOUNDARY_DATABASE_FAILED", 500);
}

function admin() {
  const client = createSupabaseAdminClient();
  if (!client) throw new BoundaryError("DATABASE_NOT_CONFIGURED", 503);
  return client;
}

/**
 * Confirms the creator belongs to the caller's organization.
 *
 * Scoped by organization so a creator id from another tenant resolves to
 * nothing rather than disclosing that the record exists -- the same rule every
 * other creator-scoped write in this codebase follows.
 */
async function requireCreator(session: AppSession, creatorId: string) {
  const { data, error } = await admin()
    .from("creators")
    .select("id,stage_name")
    .eq("organization_id", session.organizationId)
    .eq("id", creatorId)
    .maybeSingle();
  if (error) throw databaseFailure("creator-lookup", error);
  if (!data) throw new BoundaryError("CREATOR_NOT_FOUND", 404);
  return data as { id: string; stage_name: string };
}

export async function listBoundaries(session: AppSession, creatorId: string) {
  await requireCreator(session, creatorId);
  const { data, error } = await admin()
    .from("creator_boundaries")
    .select("id,boundary_type,description,severity,requires_creator_approval,active,source,created_at")
    .eq("organization_id", session.organizationId)
    .eq("creator_id", creatorId)
    .eq("active", true)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw databaseFailure("read", error);
  return z
    .array(
      z.object({
        id: z.string().uuid(),
        boundary_type: z.string(),
        description: z.string(),
        severity: z.string(),
        requires_creator_approval: z.boolean(),
        active: z.boolean(),
        source: z.string().nullable(),
        created_at: z.string(),
      }),
    )
    .parse(data ?? [])
    .map((row) => ({
      id: row.id,
      boundaryType: row.boundary_type,
      description: row.description,
      severity: row.severity,
      requiresCreatorApproval: row.requires_creator_approval,
      source: row.source,
      createdAt: row.created_at,
    }));
}

export async function createBoundary(
  session: AppSession,
  creatorId: string,
  input: z.infer<typeof boundaryCreateSchema>,
) {
  const creator = await requireCreator(session, creatorId);

  const { data, error } = await admin()
    .from("creator_boundaries")
    .insert({
      organization_id: session.organizationId,
      creator_id: creatorId,
      boundary_type: input.boundaryType,
      description: input.description,
      severity: input.severity,
      requires_creator_approval: input.requiresCreatorApproval,
      source: input.source ?? "FOUNDRY_OPERATOR",
      active: true,
      updated_at: new Date().toISOString(),
    })
    .select("id")
    .maybeSingle();
  if (error) throw databaseFailure("write", error);
  if (!data) throw new BoundaryError("BOUNDARY_CREATE_FAILED", 500);
  const created = data as { id: string };

  // Best-effort: the boundary is already recorded, and a failed audit write
  // must not tell the caller their creator's limit was not captured when it
  // was. Logged loudly instead -- this is a compliance record, so an
  // unattributed one is worth knowing about.
  try {
    await appendAudit(session, "creator.boundary.recorded", "creator", creatorId, {
      stageName: creator.stage_name,
      boundaryId: created.id,
      boundaryType: input.boundaryType,
      severity: input.severity,
    });
  } catch (auditError) {
    logEvent("error", "boundary.audit_failed", {
      creatorId,
      boundaryId: created.id,
      userId: session.userId,
      message: auditError instanceof Error ? auditError.message : String(auditError),
    });
  }

  return { id: created.id, ...input };
}
