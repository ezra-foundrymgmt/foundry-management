import "server-only";
import { z } from "zod";
import { DATA_CONFIDENCES, MAX_SOCIAL_METRIC, SOCIAL_PLATFORMS } from "@creatoros/domain";
import type { AppSession } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { appendAudit } from "@/lib/audit";
import { logEvent } from "@/lib/observability";
import { findDuplicateKey, recordImportRun } from "@/lib/import-run";

/**
 * The write path for measured social post performance.
 *
 * `social_posts` has been read since the first migration — by the daily report
 * and by baseline freezing — and written by nothing, so `reach`,
 * `profileVisits` and `outboundClicks` were structurally absent from every
 * report and every frozen baseline. Both reach rules in
 * packages/domain/src/revenue-diagnostic.ts have therefore never fired.
 *
 * Deliberately NOT a platform integration. There is no API call here, no
 * credential, no session: an operator reads the numbers off the post's own
 * insights screen and states them, with a source and a confidence attached, so
 * that a figure someone typed is a different claim from one a provider
 * reported and the difference survives into the report that cites it. A lawful
 * provider, if one ever exists, becomes another caller of this same function
 * rather than a second write path.
 */

/**
 * Every metric is a REQUIRED key that may be null.
 *
 * The one place the social schema deliberately diverges from
 * `revenueRowSchema`, which made its metrics `.optional()`.
 *
 * The hazard is STALE RETENTION, not nulling. Measured against staging rather
 * than assumed: PostgREST builds `DO UPDATE SET` only from the columns present
 * in the payload, so a re-import that omits a metric leaves the stored value
 * untouched — it does not null it. So with optional keys, a second import that
 * simply did not read `reach` leaves last week's reach sitting on the row,
 * and the report then sums a figure from one measurement session as though it
 * belonged to another. The row's `measured_at` would say one thing while one
 * of its numbers came from somewhere else entirely.
 *
 * Requiring the key forces the caller to say which it means: `"reach": null`
 * is "I did not measure this", `"reach": 0` is "I measured zero", and either
 * one is written, so the row is always a coherent snapshot of a single
 * reading. Omitting it is a 400 rather than a guess. That is "unknown is not
 * zero" applied to the wire format instead of only to the database.
 */
const metric = z.number().int().min(0).max(MAX_SOCIAL_METRIC).nullable();

export const socialPostRowSchema = z.object({
  /**
   * The identifier this same post will carry next time: the platform's post id
   * where one is available, otherwise the post's permalink.
   *
   * Required and never synthesised. A key derived from the other fields — say
   * a hash of (published_at, hook_label) — changes when the operator corrects
   * a timezone or fixes a typo, so the "idempotent" re-import inserts a second
   * row and doubles reach, invisibly, because the row looks legitimate. It
   * would also write a fabricated value into a column named external_post_id
   * that no external system ever issued, making a real platform id
   * indistinguishable from a hash forever. Unknown identity must not become
   * manufactured identity.
   */
  externalPostId: z.string().trim().min(1).max(400),
  publishedAt: z.string().datetime({ offset: true }),
  /** When the numbers were read off the platform. Distinct from publishedAt. */
  measuredAt: z.string().datetime({ offset: true }).nullable(),
  format: z.string().trim().max(60).nullable(),
  hookLabel: z.string().trim().max(200).nullable(),
  captionSummary: z.string().trim().max(2000).nullable(),
  durationSeconds: z.number().int().min(0).max(86_400).nullable(),
  views: metric,
  reach: metric,
  impressions: metric,
  likes: metric,
  comments: metric,
  shares: metric,
  saves: metric,
  profileVisits: metric,
  outboundClicks: metric,
  followsGenerated: metric,
});

export const socialImportSchema = z.object({
  /** Closed, because platform is part of the natural key. */
  platform: z.enum(SOCIAL_PLATFORMS),
  /** How the figures reached us, e.g. OPERATOR_ENTRY. */
  source: z.string().trim().min(1).max(60),
  dataConfidence: z.enum(DATA_CONFIDENCES),
  rows: z.array(socialPostRowSchema).min(1).max(200),
});

/** The measurement columns an import owns, and therefore can clear. */
const METRIC_COLUMNS = [
  "views",
  "reach",
  "impressions",
  "likes",
  "comments",
  "shares",
  "saves",
  "profile_visits",
  "outbound_clicks",
  "follows_generated",
] as const;

/** The same list as a select string; the client types .select() literally. */
const METRIC_SELECT = METRIC_COLUMNS.join(",");

/**
 * How many previously-measured figures this import replaces with null.
 *
 * Counts only measured -> unmeasured transitions. A value being CHANGED is an
 * ordinary correction and is not reported; a value being erased is what the
 * operator needs to know about, because nothing on the resulting row will
 * indicate that a number used to be there.
 */
function countClearedMeasurements(
  before: ReadonlyArray<Record<string, number | null>>,
  after: ReadonlyArray<Record<string, number | null>>,
): number {
  let cleared = 0;
  for (const row of before) {
    for (const column of METRIC_COLUMNS) {
      if (row[column] === null || row[column] === undefined) continue;
      // Every payload row carries every metric column, so a null here is a
      // deliberate "not measured in this reading".
      if (after.some((candidate) => candidate[column] === null)) cleared += 1;
    }
  }
  return cleared;
}

/** A reason the caller is allowed to see. Routes return `message` verbatim. */
export class SocialImportError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function databaseFailure(operation: string, error: { message: string }): SocialImportError {
  logEvent("error", "social_import.database_failed", { operation, message: error.message });
  return new SocialImportError("SOCIAL_IMPORT_DATABASE_FAILED", 500);
}

function admin() {
  const client = createSupabaseAdminClient();
  if (!client) throw new SocialImportError("DATABASE_NOT_CONFIGURED", 503);
  return client;
}

/**
 * Imports measured performance for one creator's posts.
 *
 * Rows are upserted on (creator_id, platform, external_post_id) — the index
 * added by migration 202609040015 — so re-importing a corrected post replaces
 * it rather than duplicating it, and a nervous double submit is harmless.
 * Every run is recorded in `data_import_runs`.
 */
export async function importCreatorSocialPosts(
  session: AppSession,
  creatorId: string,
  input: z.infer<typeof socialImportSchema>,
) {
  const client = admin();

  const creator = await client
    .from("creators")
    .select("id,stage_name")
    .eq("organization_id", session.organizationId)
    .eq("id", creatorId)
    .maybeSingle();
  if (creator.error) throw databaseFailure("creator-lookup", creator.error);
  if (!creator.data) throw new SocialImportError("CREATOR_NOT_FOUND", 404);
  const found = creator.data as { stage_name: string };

  // Two rows for one post inside a single statement is a hard PostgreSQL
  // error (21000), not an ambiguity, so it is refused before the write.
  const duplicate = findDuplicateKey(input.rows.map((row) => row.externalPostId));
  if (duplicate) throw new SocialImportError("DUPLICATE_POST_IDS_IN_PAYLOAD", 400);

  /**
   * A post cannot have been published after the moment it was measured.
   *
   * Refused rather than corrected: the likely cause is an operator pasting the
   * wrong field, and silently accepting it would place the post outside the
   * report window that `published_at` drives.
   */
  const inverted = input.rows.find(
    (row) => row.measuredAt !== null && Date.parse(row.measuredAt) < Date.parse(row.publishedAt),
  );
  if (inverted) throw new SocialImportError("MEASURED_BEFORE_PUBLISHED", 400);

  const startedAt = new Date().toISOString();
  const payload = input.rows.map((row) => ({
    organization_id: session.organizationId,
    creator_id: creatorId,
    platform: input.platform,
    external_post_id: row.externalPostId,
    published_at: row.publishedAt,
    measured_at: row.measuredAt,
    format: row.format,
    hook_label: row.hookLabel,
    caption_summary: row.captionSummary,
    duration_seconds: row.durationSeconds,
    views: row.views,
    reach: row.reach,
    impressions: row.impressions,
    likes: row.likes,
    comments: row.comments,
    shares: row.shares,
    saves: row.saves,
    profile_visits: row.profileVisits,
    outbound_clicks: row.outboundClicks,
    follows_generated: row.followsGenerated,
    source: input.source,
    data_confidence: input.dataConfidence,
  }));

  /**
   * What this import is about to overwrite.
   *
   * One import is one complete reading of a post, so the upsert REPLACES the
   * row rather than merging into it — that is what keeps every figure on a row
   * attributable to the single `measured_at` beside them, instead of mixing
   * today's reach with last week's likes under one timestamp.
   *
   * The cost is that an operator correcting one metric, and leaving the rest
   * blank, clears measurements that were previously there. That is the right
   * write, but it must not be a silent one, so the count is read first and
   * returned to the caller to be shown.
   */
  const existing = await client
    .from("social_posts")
    .select(METRIC_SELECT)
    .eq("organization_id", session.organizationId)
    .eq("creator_id", creatorId)
    .eq("platform", input.platform)
    .in(
      "external_post_id",
      input.rows.map((row) => row.externalPostId),
    );
  // A failure here must not block the import; it only costs the warning.
  const clearedMeasurements = existing.error
    ? null
    : countClearedMeasurements(
        (existing.data ?? []) as unknown as Array<Record<string, number | null>>,
        payload as unknown as Array<Record<string, number | null>>,
      );

  const { data, error } = await client
    .from("social_posts")
    .upsert(payload, { onConflict: "creator_id,platform,external_post_id" })
    .select("id");
  if (error) throw databaseFailure("write", error);
  const written = Array.isArray(data) ? data.length : 0;

  await recordImportRun(client, {
    organizationId: session.organizationId,
    creatorId,
    // provider is the external system; source is how the data reached us.
    provider: input.platform,
    source: input.source,
    idempotencyKey: `social:${creatorId}:${input.platform}:${input.source}:${startedAt}`,
    rowsReceived: input.rows.length,
    rowsWritten: written,
    startedAt,
  });

  try {
    await appendAudit(session, "creator.social.imported", "creator", creatorId, {
      stageName: found.stage_name,
      platform: input.platform,
      source: input.source,
      dataConfidence: input.dataConfidence,
      rows: input.rows.length,
    });
  } catch (auditError) {
    logEvent("error", "social_import.audit_failed", {
      creatorId,
      userId: session.userId,
      message: auditError instanceof Error ? auditError.message : String(auditError),
    });
  }

  return {
    creatorId,
    rowsReceived: input.rows.length,
    rowsWritten: written,
    platform: input.platform,
    source: input.source,
    dataConfidence: input.dataConfidence,
    // null when the pre-read failed: not zero, which would claim nothing was
    // cleared when we simply do not know.
    clearedMeasurements,
  };
}
