import "server-only";
import { z } from "zod";
import { PIPELINE_STAGES } from "@creatoros/domain";
import type { AppSession } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { appendAudit } from "@/lib/audit";
import { logEvent } from "@/lib/observability";

export const prospectCreateSchema = z.object({
  preferredName: z.string().trim().min(1).max(120),
  stageName: z.string().trim().min(1).max(120),
  email: z.string().email().max(200).optional(),
  niche: z.string().trim().max(120).optional(),
  primarySocialPlatform: z.string().trim().max(60).optional(),
  instagramUrl: z.string().url().max(500).optional(),
  followerCountEstimate: z.number().int().min(0).max(1_000_000_000).optional(),
  source: z.string().trim().max(80).optional(),
  opportunityNotes: z.string().trim().max(4000).optional(),
});

export const prospectUpdateSchema = z
  .object({
    pipelineStage: z.enum(PIPELINE_STAGES).optional(),
    assignedOwner: z.string().uuid().nullable().optional(),
    nextFollowupAt: z.string().datetime().nullable().optional(),
    qualificationStatus: z.string().trim().max(60).optional(),
    fitScore: z.number().int().min(0).max(100).nullable().optional(),
    fitTier: z.string().trim().max(40).optional(),
    opportunityNotes: z.string().trim().max(4000).optional(),
    archived: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "NO_FIELDS_TO_UPDATE" });

export const prospectActivitySchema = z.object({
  activityType: z.enum(["NOTE", "CALL", "EMAIL", "DM", "MEETING", "STAGE_CHANGE"]),
  body: z.string().trim().min(1).max(4000),
  occurredAt: z.string().datetime().optional(),
});

/**
 * A reason the caller is allowed to see. The routes return `message` verbatim,
 * so nothing constructed from a driver error may be one.
 */
export class ProspectError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Adversarial review, confirmed: seven sites wrapped the Supabase driver's own
 * message in ProspectError, and the routes return that verbatim. A body
 * containing a NUL byte — which passes the zod check, because trim() does not
 * strip it — made Postgres answer 22P05 and handed its text to the browser.
 * Schema drift, a downgraded key, or a statement timeout would each do the same,
 * naming internal tables, columns and constraints.
 *
 * The reason stays in the server log, where it is useful, and the caller gets a
 * code that says what happened without describing how.
 */
function databaseFailure(operation: string, error: { message: string }): ProspectError {
  logEvent("error", "prospect.database_failed", { operation, message: error.message });
  return new ProspectError("PROSPECT_DATABASE_FAILED", 500);
}

function admin() {
  const client = createSupabaseAdminClient();
  if (!client) throw new ProspectError("DATABASE_NOT_CONFIGURED", 503);
  return client;
}

/** Normalised for duplicate detection: case and punctuation should not create a second record. */
function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Creates a prospect, refusing an obvious duplicate.
 *
 * Duplicate prevention matches on email when present, otherwise on a normalised
 * stage name within the same organization. Prospecting is a volume activity and
 * the same creator surfaces from several sources; two records for one person
 * split their history and lose the earlier outreach.
 */
export async function createProspect(
  session: AppSession,
  input: z.infer<typeof prospectCreateSchema>,
) {
  const client = admin();
  const normalized = normalizeName(input.stageName);

  const existing = await client
    .from("prospects")
    .select("id,stage_name,email,prospect_number")
    .eq("organization_id", session.organizationId)
    .is("archived_at", null)
    .limit(500);
  if (existing.error) throw databaseFailure("duplicate-scan", existing.error);

  const duplicate = (existing.data ?? []).find((row) => {
    const candidate = row as { id: string; stage_name: string; email: string | null };
    if (input.email && candidate.email)
      return candidate.email.toLowerCase() === input.email.toLowerCase();
    return normalizeName(candidate.stage_name) === normalized;
  }) as { id: string; prospect_number: string } | undefined;
  if (duplicate) throw new ProspectError(`DUPLICATE_PROSPECT:${duplicate.prospect_number}`, 409);

  const { data, error } = await client
    .from("prospects")
    .insert({
      organization_id: session.organizationId,
      preferred_name: input.preferredName,
      stage_name: input.stageName,
      email: input.email ?? null,
      niche: input.niche ?? null,
      primary_social_platform: input.primarySocialPlatform ?? null,
      instagram_url: input.instagramUrl ?? null,
      follower_count_estimate: input.followerCountEstimate ?? null,
      source: input.source ?? "MANUAL",
      opportunity_notes: input.opportunityNotes ?? null,
      pipeline_stage: "SOURCED",
      assigned_owner: session.userId,
    })
    .select("id,prospect_number,stage_name,pipeline_stage")
    .single();
  if (error) throw databaseFailure("write", error);

  const created = data as { id: string; prospect_number: string };
  await appendAudit(session, "prospect.created", "prospect", created.id, {
    prospectNumber: created.prospect_number,
  });
  return created;
}

/**
 * Updates a prospect. Ownership is proven from the session's organization, never
 * from the request, so a prospect id from another tenant simply does not match.
 */
export async function updateProspect(
  session: AppSession,
  prospectId: string,
  input: z.infer<typeof prospectUpdateSchema>,
) {
  const client = admin();
  const current = await client
    .from("prospects")
    .select("id,pipeline_stage,prospect_number")
    .eq("organization_id", session.organizationId)
    .eq("id", prospectId)
    .maybeSingle();
  if (current.error) throw databaseFailure("read-current", current.error);
  if (!current.data) throw new ProspectError("PROSPECT_NOT_FOUND", 404);
  const before = current.data as { pipeline_stage: string; prospect_number: string };

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.pipelineStage !== undefined) patch["pipeline_stage"] = input.pipelineStage;
  if (input.assignedOwner !== undefined) patch["assigned_owner"] = input.assignedOwner;
  if (input.nextFollowupAt !== undefined) patch["next_followup_at"] = input.nextFollowupAt;
  if (input.qualificationStatus !== undefined)
    patch["qualification_status"] = input.qualificationStatus;
  if (input.fitScore !== undefined) patch["fit_score"] = input.fitScore;
  if (input.fitTier !== undefined) patch["fit_tier"] = input.fitTier;
  if (input.opportunityNotes !== undefined) patch["opportunity_notes"] = input.opportunityNotes;
  // Archive is a soft delete: the record and its history stay, it just leaves
  // the working pipeline. Nothing in CreatorOS hard-deletes a prospect.
  if (input.archived !== undefined)
    patch["archived_at"] = input.archived ? new Date().toISOString() : null;

  const { data, error } = await client
    .from("prospects")
    .update(patch)
    .eq("organization_id", session.organizationId)
    .eq("id", prospectId)
    .select("id,prospect_number,pipeline_stage,archived_at")
    .maybeSingle();
  if (error) throw databaseFailure("write", error);
  if (!data) throw new ProspectError("PROSPECT_NOT_FOUND", 404);

  // A stage change is the event operators reconstruct a pipeline from, so it is
  // written to the activity timeline as well as the audit log.
  if (input.pipelineStage && input.pipelineStage !== before.pipeline_stage)
    await client.from("prospect_activities").insert({
      organization_id: session.organizationId,
      prospect_id: prospectId,
      activity_type: "STAGE_CHANGE",
      body: `${before.pipeline_stage} → ${input.pipelineStage}`,
      created_by: session.userId,
    });

  await appendAudit(session, "prospect.updated", "prospect", prospectId, {
    fields: Object.keys(input),
  });
  return data;
}

export async function addProspectActivity(
  session: AppSession,
  prospectId: string,
  input: z.infer<typeof prospectActivitySchema>,
) {
  const client = admin();
  const owner = await client
    .from("prospects")
    .select("id")
    .eq("organization_id", session.organizationId)
    .eq("id", prospectId)
    .maybeSingle();
  if (owner.error) throw databaseFailure("read-owner", owner.error);
  if (!owner.data) throw new ProspectError("PROSPECT_NOT_FOUND", 404);

  const { data, error } = await client
    .from("prospect_activities")
    .insert({
      organization_id: session.organizationId,
      prospect_id: prospectId,
      activity_type: input.activityType,
      body: input.body,
      occurred_at: input.occurredAt ?? new Date().toISOString(),
      created_by: session.userId,
    })
    .select("id,activity_type,occurred_at")
    .single();
  if (error) throw databaseFailure("write", error);

  await appendAudit(session, "prospect.activity_logged", "prospect", prospectId, {
    activityType: input.activityType,
  });
  return data;
}

export async function listProspectActivities(session: AppSession, prospectId: string) {
  const client = admin();
  const { data, error } = await client
    .from("prospect_activities")
    .select("id,activity_type,body,occurred_at,created_by")
    .eq("organization_id", session.organizationId)
    .eq("prospect_id", prospectId)
    .order("occurred_at", { ascending: false })
    .limit(50);
  if (error) throw databaseFailure("write", error);
  return data ?? [];
}
