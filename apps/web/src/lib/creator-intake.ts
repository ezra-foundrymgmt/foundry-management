import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  composeIntakeUrl,
  composeReferenceCode,
  intakeBlockers,
  mapIntakeSubmission,
  type IntakeAnswer,
  type MappedIntake,
} from "@creatoros/domain";
import type { AppSession } from "@/lib/auth";
import { appendAudit } from "@/lib/audit";
import { logEvent } from "@/lib/observability";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * The creator intake pipeline: issue a link, receive a submission, apply it.
 *
 * Receiving and applying are deliberately two operations with two different
 * authorities. Receiving is unauthenticated — it is a Google Form POST, and the
 * reference code inside it is a field the creator can see and edit, so nothing
 * about a submission can be trusted to say who sent it. Applying is
 * authenticated, permissioned and audited, and it is the only thing that writes
 * to a creator record.
 *
 * That split is what makes an editable prefill safe: a forged or mistyped code
 * can at worst attach reviewable data to a real creator, which an operator then
 * rejects. It can never change anything on its own.
 */

/** A reason the caller is allowed to see. */
export class IntakeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function admin() {
  const client = createSupabaseAdminClient();
  if (!client) throw new IntakeError("DATABASE_NOT_CONFIGURED", 503);
  return client;
}

/** How long a creator has to fill the form before the link stops matching. */
const LINK_LIFETIME_DAYS = 30;

export const intakePayloadSchema = z.object({
  formId: z.string().trim().min(1).max(120),
  responseId: z.string().trim().min(1).max(200),
  submittedAt: z.string().datetime({ offset: true }),
  respondentEmail: z.string().trim().max(320).nullable().optional(),
  answers: z
    .array(
      z.object({
        itemId: z.coerce.number().int(),
        title: z.string().max(500).default(""),
        values: z.array(z.string().max(8000)).max(50),
      }),
    )
    .max(100),
});

export type IntakePayload = z.infer<typeof intakePayloadSchema>;

/**
 * Identifies one submission by its content as well as its response id.
 *
 * Google Forms fires for new AND edited responses, and an edit keeps the
 * original response id. Hashing the answers means a transport retry collides
 * and is a no-op, while a genuine correction lands as a new row for review —
 * so a creator fixing a mistake is never silently swallowed.
 */
function contentHash(answers: IntakeAnswer[]): string {
  const normalized = [...answers]
    .map((answer) => ({ itemId: answer.itemId, values: [...answer.values] }))
    .sort((a, b) => a.itemId - b.itemId);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

// ---------------------------------------------------------------------------
// 1. Issue a link
// ---------------------------------------------------------------------------

/**
 * Mints the reference code for one creator and returns the URL she opens.
 *
 * The code is not a secret and is not treated as one — it is printed into a
 * form she reads. The random suffix exists so that a mistyped or forwarded code
 * cannot land on a neighbouring creator, not to make it unguessable.
 */
export async function issueIntakeLink(
  session: AppSession,
  creatorId: string,
): Promise<{ referenceCode: string; url: string; expiresAt: string }> {
  const client = admin();

  const creator = await client
    .from("creators")
    .select("id,creator_number,stage_name")
    .eq("organization_id", session.organizationId)
    .eq("id", creatorId)
    .maybeSingle();
  if (creator.error) throw new IntakeError("INTAKE_DATABASE_FAILED", 500);
  const found = creator.data as { creator_number: string; stage_name: string } | null;
  if (!found) throw new IntakeError("CREATOR_NOT_FOUND", 404);

  const referenceCode = composeReferenceCode(
    found.creator_number,
    randomBytes(4).toString("hex"),
  );
  const expiresAt = new Date(Date.now() + LINK_LIFETIME_DAYS * 86_400_000).toISOString();

  const { data, error } = await client
    .from("creator_intake_links")
    .insert({
      organization_id: session.organizationId,
      creator_id: creatorId,
      reference_code: referenceCode,
      issued_by: session.userId,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    })
    .select("id")
    .maybeSingle();
  if (error || !data) throw new IntakeError("INTAKE_LINK_FAILED", 500);

  try {
    await appendAudit(session, "creator.intake_link.issued", "creator", creatorId, {
      stageName: found.stage_name,
      referenceCode,
      expiresAt,
    });
  } catch (auditError) {
    logEvent("error", "intake.audit_failed", {
      creatorId,
      message: auditError instanceof Error ? auditError.message : String(auditError),
    });
  }

  return { referenceCode, url: composeIntakeUrl(referenceCode), expiresAt };
}

// ---------------------------------------------------------------------------
// 2. Receive a submission (unauthenticated)
// ---------------------------------------------------------------------------

export type IntakeReceipt =
  | { stored: true; submissionId: string; status: string; matched: boolean; duplicate: boolean }
  | { stored: false; reason: "UNKNOWN_FORM" };

/**
 * Stores what arrived. Writes nothing to any creator record.
 *
 * Every outcome short of "we do not know this form" ends in a stored row,
 * including a submission whose reference code matches nothing. A creator who
 * cleared the box has still told Foundry things about herself, and discarding
 * that because a field she could edit was edited would be the worst possible
 * reading of an editable field.
 */
export async function receiveIntakeSubmission(payload: IntakePayload): Promise<IntakeReceipt> {
  const client = admin();

  /**
   * The tenant comes from the FORM, not from the reference code.
   *
   * A form belongs to exactly one organisation whatever the respondent typed,
   * so an unmatched submission still has a known owner and can be reviewed
   * rather than orphaned.
   */
  const org = await client
    .from("organizations")
    .select("id")
    .eq("settings_json->>intakeFormId", payload.formId)
    .maybeSingle();
  if (org.error) throw new IntakeError("INTAKE_DATABASE_FAILED", 500);
  const organizationId = (org.data as { id: string } | null)?.id;
  if (!organizationId) return { stored: false, reason: "UNKNOWN_FORM" };

  const mapped = mapIntakeSubmission({
    answers: payload.answers,
    respondentEmail: payload.respondentEmail ?? null,
  });

  let creatorId: string | null = null;
  let intakeLinkId: string | null = null;
  if (mapped.referenceCode) {
    const link = await client
      .from("creator_intake_links")
      .select("id,creator_id,expires_at,revoked_at")
      .eq("organization_id", organizationId)
      .eq("reference_code", mapped.referenceCode)
      .maybeSingle();
    if (link.error) throw new IntakeError("INTAKE_DATABASE_FAILED", 500);
    const row = link.data as {
      id: string;
      creator_id: string;
      expires_at: string;
      revoked_at: string | null;
    } | null;
    // An expired or revoked link still identifies the creator; it just does not
    // get to skip review. Refusing to name her would make an operator match a
    // submission by hand that the system could already see the answer to.
    if (row && !row.revoked_at) {
      creatorId = row.creator_id;
      intakeLinkId = row.id;
    }
  }

  const status = creatorId ? "PENDING_REVIEW" : "UNMATCHED";
  const { data, error } = await client
    .from("creator_intake_submissions")
    .upsert(
      {
        organization_id: organizationId,
        creator_id: creatorId,
        intake_link_id: intakeLinkId,
        provider: "GOOGLE_FORMS",
        external_response_id: payload.responseId,
        external_form_id: payload.formId,
        content_hash: contentHash(payload.answers),
        reference_code_submitted: mapped.referenceCode,
        respondent_email: mapped.respondentEmail,
        submitted_at: payload.submittedAt,
        status,
        raw_payload_json: payload,
        mapped_json: mapped as unknown as Record<string, unknown>,
        unrecognized_json: mapped.unrecognized,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "provider,external_response_id,content_hash", ignoreDuplicates: true },
    )
    .select("id")
    .maybeSingle();
  if (error) throw new IntakeError("INTAKE_WRITE_FAILED", 500);

  // ignoreDuplicates returns no row when the identical delivery already landed.
  if (!data) {
    const existing = await client
      .from("creator_intake_submissions")
      .select("id,status")
      .eq("provider", "GOOGLE_FORMS")
      .eq("external_response_id", payload.responseId)
      .eq("content_hash", contentHash(payload.answers))
      .maybeSingle();
    const row = existing.data as { id: string; status: string } | null;
    if (!row) throw new IntakeError("INTAKE_WRITE_FAILED", 500);
    return {
      stored: true,
      submissionId: row.id,
      status: row.status,
      matched: creatorId !== null,
      duplicate: true,
    };
  }

  logEvent("info", "creator.intake.received", {
    organizationId,
    creatorId: creatorId ?? undefined,
    status,
    unrecognized: mapped.unrecognized.length,
  });

  return {
    stored: true,
    submissionId: (data as { id: string }).id,
    status,
    matched: creatorId !== null,
    duplicate: false,
  };
}

// ---------------------------------------------------------------------------
// 3. Apply a submission (authenticated)
// ---------------------------------------------------------------------------

/**
 * Writes a reviewed submission onto the creator record.
 *
 * Refuses rather than partially applies when the submission carries a blocker.
 * Notably it does NOT set creators.adult_confirmation_status: that column is a
 * Foundry judgement recorded against the person who made it, and a creator
 * ticking a box on her own form is evidence for that decision, not the decision.
 * What this writes is the evidence — into creator_compliance_checks, which has
 * modelled exactly this (evidence_reference, reviewed_by, reviewed_at) since the
 * first migration and has never been used.
 */
export async function applyIntakeSubmission(
  session: AppSession,
  submissionId: string,
): Promise<{ applied: true; creatorId: string; counts: Record<string, number> }> {
  const client = admin();

  const found = await client
    .from("creator_intake_submissions")
    .select("id,creator_id,status,mapped_json,intake_link_id")
    .eq("organization_id", session.organizationId)
    .eq("id", submissionId)
    .maybeSingle();
  if (found.error) throw new IntakeError("INTAKE_DATABASE_FAILED", 500);
  const submission = found.data as {
    creator_id: string | null;
    status: string;
    mapped_json: MappedIntake;
    intake_link_id: string | null;
  } | null;
  if (!submission) throw new IntakeError("SUBMISSION_NOT_FOUND", 404);
  if (submission.status === "APPLIED") throw new IntakeError("ALREADY_APPLIED", 409);
  if (!submission.creator_id) throw new IntakeError("SUBMISSION_NOT_MATCHED_TO_CREATOR", 409);

  const mapped = submission.mapped_json;
  const blockers = intakeBlockers(mapped);
  if (blockers.length > 0) throw new IntakeError(`INTAKE_BLOCKED:${blockers.join(",")}`, 409);

  const creatorId = submission.creator_id;
  const organizationId = session.organizationId;
  const now = new Date().toISOString();
  const counts: Record<string, number> = {};

  const write = async (
    table: string,
    rows: Array<Record<string, unknown>>,
    onConflict: string,
  ) => {
    if (rows.length === 0) return;
    const { error } = await client
      .from(table)
      .upsert(
        rows.map((row) => ({ organization_id: organizationId, creator_id: creatorId, ...row })),
        { onConflict },
      );
    if (error) throw new IntakeError(`INTAKE_APPLY_FAILED:${table}`, 500);
    counts[table] = rows.length;
  };

  // Partial upsert: PostgREST preserves columns the payload omits, so this
  // fills the profile without erasing anything a person typed in later.
  if (Object.keys(mapped.brandProfile).length > 0)
    await write("creator_brand_profiles", [{ ...mapped.brandProfile, updated_at: now }], "creator_id");

  await write(
    "creator_boundaries",
    mapped.boundaries.map((boundary) => ({
      intake_key: boundary.intakeKey,
      boundary_type: boundary.boundaryType,
      description: boundary.description,
      severity: boundary.severity,
      requires_creator_approval: boundary.requiresCreatorApproval,
      source: boundary.source,
      updated_at: now,
    })),
    "creator_id,intake_key",
  );

  await write(
    "creator_truth_items",
    mapped.truthItems.map((item) => ({
      intake_key: item.intakeKey,
      item_type: item.itemType,
      category: item.category,
      statement: item.statement,
      status: item.status,
      updated_at: now,
    })),
    "creator_id,intake_key",
  );

  await write(
    "content_pillars",
    mapped.contentPillars.map((pillar) => ({
      name: pillar.name,
      description: pillar.description,
      updated_at: now,
    })),
    "creator_id,name",
  );

  // The activation workflow already created one row per platform with a NULL
  // handle and this idempotency key; upserting on it fills the handle in rather
  // than creating a second account for the same platform.
  await write(
    "social_accounts",
    mapped.socialHandles.map((account) => ({
      provider: account.provider,
      handle: account.handle,
      idempotency_key: `activation:${creatorId}:social:${account.provider}`,
      updated_at: now,
    })),
    "organization_id,idempotency_key",
  );

  await write(
    "creator_compliance_checks",
    [
      {
        check_type: "ADULT_CONFIRMATION",
        // Not CONFIRMED. She stated it; nobody at Foundry has verified it yet,
        // and the gate is a Foundry decision.
        status: "CREATOR_ATTESTED",
        evidence_reference: `creator_intake_submissions:${submissionId}`,
        notes:
          mapped.adult.reportedAge === null
            ? "Creator attested 18+. No readable age given."
            : `Creator attested 18+ and reported age ${mapped.adult.reportedAge}.`,
        updated_at: now,
      },
    ],
    "creator_id,check_type",
  );

  const marked = await client
    .from("creator_intake_submissions")
    .update({ status: "APPLIED", applied_at: now, applied_by: session.userId, updated_at: now })
    .eq("organization_id", organizationId)
    .eq("id", submissionId);
  if (marked.error) throw new IntakeError("INTAKE_APPLY_FAILED:submission", 500);

  if (submission.intake_link_id)
    await client
      .from("creator_intake_links")
      .update({ redeemed_at: now, updated_at: now })
      .eq("id", submission.intake_link_id);

  try {
    await appendAudit(session, "creator.intake.applied", "creator", creatorId, {
      submissionId,
      counts,
      reportedAge: mapped.adult.reportedAge,
      reviewNotes: mapped.reviewNotes,
      unrecognized: mapped.unrecognized.length,
    });
  } catch (auditError) {
    logEvent("error", "intake.audit_failed", {
      creatorId,
      message: auditError instanceof Error ? auditError.message : String(auditError),
    });
  }

  /**
   * Nudges an activation parked at AWAIT_INTAKE.
   *
   * Best-effort on purpose. Most applies have no parked run behind them — a
   * creator who was activated months ago, or one whose intake arrives before
   * anyone starts her activation — and `resumeCreatorActivation` throws
   * NO_RESUMABLE_RUN for exactly those. Letting that failure undo an apply that
   * already wrote her boundaries would be strictly worse than a run that waits
   * for the next resume, which the workflows page can send by hand.
   *
   * Imported lazily so the intake module does not drag the Inngest client into
   * every caller that only wants to read submissions.
   */
  try {
    const { resumeCreatorActivation } = await import("@/lib/activation-commands");
    await resumeCreatorActivation(session, {
      creatorId,
      correlationId: `intake-${submissionId}`,
    });
    logEvent("info", "creator.intake.activation_resumed", { creatorId, submissionId });
  } catch (resumeError) {
    const message = resumeError instanceof Error ? resumeError.message : String(resumeError);
    // NO_RESUMABLE_RUN is the ordinary case, not a fault, so it is not an error.
    logEvent(message === "NO_RESUMABLE_RUN" ? "info" : "warn", "creator.intake.resume_skipped", {
      creatorId,
      submissionId,
      reason: message,
    });
  }

  return { applied: true, creatorId, counts };
}

// ---------------------------------------------------------------------------
// 4. Review
// ---------------------------------------------------------------------------

export interface IntakeSubmissionSummary {
  id: string;
  status: string;
  creatorId: string | null;
  creatorName: string | null;
  referenceCodeSubmitted: string | null;
  respondentEmail: string | null;
  submittedAt: string;
  appliedAt: string | null;
  errorMessage: string | null;
  mapped: MappedIntake;
  blockers: string[];
}

const mappedShape = z.object({
  brandProfile: z.record(z.string(), z.unknown()).default({}),
  boundaries: z.array(z.record(z.string(), z.unknown())).default([]),
  truthItems: z.array(z.record(z.string(), z.unknown())).default([]),
  contentPillars: z.array(z.record(z.string(), z.unknown())).default([]),
  socialHandles: z.array(z.record(z.string(), z.unknown())).default([]),
  referenceCode: z.string().nullable().default(null),
  respondentEmail: z.string().nullable().default(null),
  statedStageName: z.string().nullable().default(null),
  adult: z
    .object({
      attested: z.boolean().default(false),
      reportedAge: z.number().nullable().default(null),
      rawAge: z.string().nullable().default(null),
      belowMinimum: z.boolean().default(false),
    })
    .default({ attested: false, reportedAge: null, rawAge: null, belowMinimum: false }),
  reviewNotes: z.array(z.string()).default([]),
  unrecognized: z.array(z.record(z.string(), z.unknown())).default([]),
});

/**
 * What the operator sees before deciding.
 *
 * Tolerant on the mapped shape: a submission stored by an older version of the
 * mapper must still be reviewable, because refusing to render it would strand
 * a creator's answers with no way to act on them.
 */
export async function listIntakeSubmissions(
  session: AppSession,
  options: { limit?: number } = {},
): Promise<IntakeSubmissionSummary[]> {
  const client = admin();
  const { data, error } = await client
    .from("creator_intake_submissions")
    .select(
      "id,status,creator_id,reference_code_submitted,respondent_email,submitted_at,applied_at,error_message,mapped_json,creators(stage_name)",
    )
    .eq("organization_id", session.organizationId)
    .order("received_at", { ascending: false })
    .limit(options.limit ?? 50);
  if (error) throw new IntakeError("INTAKE_DATABASE_FAILED", 500);

  return (data ?? []).flatMap((raw) => {
    const row = raw as Record<string, unknown>;
    const parsed = mappedShape.safeParse(row["mapped_json"]);
    if (!parsed.success) {
      logEvent("warn", "intake.unreadable_mapping", { submissionId: String(row["id"]) });
      return [];
    }
    const mapped = parsed.data as unknown as MappedIntake;
    return [
      {
        id: String(row["id"]),
        status: String(row["status"]),
        creatorId: (row["creator_id"] as string | null) ?? null,
        creatorName:
          (row["creators"] as { stage_name?: string } | null)?.stage_name ?? null,
        referenceCodeSubmitted: (row["reference_code_submitted"] as string | null) ?? null,
        respondentEmail: (row["respondent_email"] as string | null) ?? null,
        submittedAt: String(row["submitted_at"]),
        appliedAt: (row["applied_at"] as string | null) ?? null,
        errorMessage: (row["error_message"] as string | null) ?? null,
        mapped,
        blockers: intakeBlockers(mapped),
      },
    ];
  });
}

/** Records that a submission was looked at and deliberately not applied. */
export async function rejectIntakeSubmission(
  session: AppSession,
  submissionId: string,
  reason: string,
): Promise<{ rejected: true }> {
  const client = admin();
  const { data, error } = await client
    .from("creator_intake_submissions")
    .update({
      status: "REJECTED",
      error_message: reason,
      applied_by: session.userId,
      applied_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", session.organizationId)
    .eq("id", submissionId)
    // An applied submission is a historical fact; rejecting it afterwards would
    // misdescribe what happened to the creator record.
    .neq("status", "APPLIED")
    .select("id")
    .maybeSingle();
  if (error) throw new IntakeError("INTAKE_DATABASE_FAILED", 500);
  if (!data) throw new IntakeError("SUBMISSION_NOT_REJECTABLE", 409);

  try {
    await appendAudit(session, "creator.intake.rejected", "creator_intake_submission", submissionId, {
      reason,
    });
  } catch {
    /* audit failure must not undo the rejection */
  }
  return { rejected: true };
}

/**
 * Attaches a submission to a creator by hand.
 *
 * The recovery path for the one thing an editable prefill guarantees will
 * happen: a creator clears or mistypes the reference code. Her email usually
 * makes the match obvious, and an operator asserting it is a better record than
 * a fuzzy match the system guessed at.
 */
export async function matchIntakeSubmission(
  session: AppSession,
  submissionId: string,
  creatorId: string,
): Promise<{ matched: true }> {
  const client = admin();
  const creator = await client
    .from("creators")
    .select("id,stage_name")
    .eq("organization_id", session.organizationId)
    .eq("id", creatorId)
    .maybeSingle();
  if (creator.error) throw new IntakeError("INTAKE_DATABASE_FAILED", 500);
  if (!creator.data) throw new IntakeError("CREATOR_NOT_FOUND", 404);

  const { data, error } = await client
    .from("creator_intake_submissions")
    .update({
      creator_id: creatorId,
      status: "PENDING_REVIEW",
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", session.organizationId)
    .eq("id", submissionId)
    .eq("status", "UNMATCHED")
    .select("id")
    .maybeSingle();
  if (error) throw new IntakeError("INTAKE_DATABASE_FAILED", 500);
  if (!data) throw new IntakeError("SUBMISSION_NOT_UNMATCHED", 409);

  try {
    await appendAudit(session, "creator.intake.matched", "creator", creatorId, {
      submissionId,
      stageName: (creator.data as { stage_name: string }).stage_name,
    });
  } catch {
    /* audit failure must not undo the match */
  }
  return { matched: true };
}
