import "server-only";
import { z } from "zod";
import type { AppSession } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { appendAudit } from "@/lib/audit";
import { logEvent } from "@/lib/observability";

/**
 * Freezes the creator's own normal, which every later report is measured against.
 *
 * `creator_baselines` was read in four places -- including the WAITING
 * activation gate and the hard precondition of every daily report -- and
 * written by nothing. That single absence stopped every creator reaching
 * ACTIVE and returned NO_BASELINE_FROZEN from every scheduler pass, which is
 * why the report pipeline had never produced a row in any environment.
 *
 * The baseline is COMPUTED from measured rows over the chosen period, never
 * typed. A typed baseline is an assertion about a creator's normal that
 * nobody measured, and every subsequent comparison would inherit it.
 */
export const baselineFreezeSchema = z
  .object({
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "periodStart must be YYYY-MM-DD"),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "periodEnd must be YYYY-MM-DD"),
    baselineType: z.string().trim().min(1).max(40).default("ROLLING_30D"),
  })
  .refine((value) => value.periodStart <= value.periodEnd, {
    message: "PERIOD_START_AFTER_END",
  });

/** A reason the caller is allowed to see. Routes return `message` verbatim. */
export class BaselineError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function databaseFailure(operation: string, error: { message: string }): BaselineError {
  logEvent("error", "baseline.database_failed", { operation, message: error.message });
  return new BaselineError("BASELINE_DATABASE_FAILED", 500);
}

function admin() {
  const client = createSupabaseAdminClient();
  if (!client) throw new BaselineError("DATABASE_NOT_CONFIGURED", 503);
  return client;
}

const revenueRowsSchema = z.array(
  z.object({
    creator_platform_receipts: z.coerce.number().nullable(),
    new_subscribers: z.coerce.number().nullable(),
    first_buyers: z.coerce.number().nullable(),
  }),
);

const socialRowsSchema = z.array(
  z.object({
    reach: z.coerce.number().nullable(),
    profile_visits: z.coerce.number().nullable(),
    outbound_clicks: z.coerce.number().nullable(),
  }),
);

/**
 * Freezes a baseline for a creator over an explicit measured period.
 *
 * Refuses when the period holds no measured rows at all. Freezing an all-zero
 * baseline would be worse than refusing: `percentChange` treats a zero
 * baseline as incomparable and returns null, so every future comparison
 * against it would silently produce no signal while the creator appeared to
 * have a baseline. An operator who cannot freeze is told to import first,
 * which is the truth.
 *
 * A dimension with no source rows -- reach, profile visits and outbound
 * clicks, until social ingestion exists -- is recorded as zero and named in
 * `unmeasuredDimensions`. That is safe for the same reason: those dimensions
 * cannot fire a rule against a zero baseline, so they produce no false signal
 * while the measured dimensions work normally.
 */
export async function freezeBaseline(
  session: AppSession,
  creatorId: string,
  input: z.infer<typeof baselineFreezeSchema>,
) {
  const client = admin();

  const creator = await client
    .from("creators")
    .select("id,stage_name")
    .eq("organization_id", session.organizationId)
    .eq("id", creatorId)
    .maybeSingle();
  if (creator.error) throw databaseFailure("creator-lookup", creator.error);
  if (!creator.data) throw new BaselineError("CREATOR_NOT_FOUND", 404);
  const found = creator.data as { stage_name: string };

  const [revenue, social] = await Promise.all([
    client
      .from("creator_revenue_daily")
      .select("creator_platform_receipts,new_subscribers,first_buyers")
      .eq("organization_id", session.organizationId)
      .eq("creator_id", creatorId)
      .gte("date", input.periodStart)
      .lte("date", input.periodEnd),
    client
      .from("social_posts")
      .select("reach,profile_visits,outbound_clicks")
      .eq("organization_id", session.organizationId)
      .eq("creator_id", creatorId)
      .gte("published_at", `${input.periodStart}T00:00:00Z`)
      .lte("published_at", `${input.periodEnd}T23:59:59Z`),
  ]);
  if (revenue.error) throw databaseFailure("revenue-read", revenue.error);
  if (social.error) throw databaseFailure("social-read", social.error);

  const revenueRows = revenueRowsSchema.parse(revenue.data ?? []);
  const socialRows = socialRowsSchema.parse(social.data ?? []);
  if (revenueRows.length === 0 && socialRows.length === 0)
    throw new BaselineError("NO_MEASURED_DATA_IN_PERIOD", 409);

  const sum = (values: Array<number | null>) =>
    values.reduce((total: number, value) => total + (value ?? 0), 0);

  const metrics = {
    date: input.periodEnd,
    reach: sum(socialRows.map((row) => row.reach)),
    profileVisits: sum(socialRows.map((row) => row.profile_visits)),
    outboundClicks: sum(socialRows.map((row) => row.outbound_clicks)),
    newSubscribers: sum(revenueRows.map((row) => row.new_subscribers)),
    firstBuyers: sum(revenueRows.map((row) => row.first_buyers)),
    revenue: sum(revenueRows.map((row) => row.creator_platform_receipts)),
  };

  const unmeasuredDimensions = [
    ...(socialRows.length === 0 ? ["reach", "profileVisits", "outboundClicks"] : []),
    ...(revenueRows.length === 0 ? ["newSubscribers", "firstBuyers", "revenue"] : []),
  ];

  // `unique(creator_id, baseline_type, version)`: a re-freeze is a new
  // version, never an overwrite. The previous baseline stays readable, so a
  // report generated against it remains explicable after the fact.
  const latest = await client
    .from("creator_baselines")
    .select("version")
    .eq("organization_id", session.organizationId)
    .eq("creator_id", creatorId)
    .eq("baseline_type", input.baselineType)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latest.error) throw databaseFailure("version-read", latest.error);
  const previousVersion = z.object({ version: z.coerce.number() }).safeParse(latest.data);
  const version = (previousVersion.success ? previousVersion.data.version : 0) + 1;

  const frozenAt = new Date().toISOString();
  const { data, error } = await client
    .from("creator_baselines")
    .insert({
      organization_id: session.organizationId,
      creator_id: creatorId,
      period_start: input.periodStart,
      period_end: input.periodEnd,
      baseline_type: input.baselineType,
      version,
      metrics_json: metrics,
      frozen_at: frozenAt,
      created_by: session.userId,
    })
    .select("id")
    .maybeSingle();
  if (error) throw databaseFailure("write", error);
  if (!data) throw new BaselineError("BASELINE_FREEZE_FAILED", 500);
  const created = data as { id: string };

  try {
    await appendAudit(session, "creator.baseline.frozen", "creator", creatorId, {
      stageName: found.stage_name,
      baselineId: created.id,
      baselineType: input.baselineType,
      version,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      revenueDays: revenueRows.length,
      socialPosts: socialRows.length,
      unmeasuredDimensions,
    });
  } catch (auditError) {
    logEvent("error", "baseline.audit_failed", {
      creatorId,
      userId: session.userId,
      message: auditError instanceof Error ? auditError.message : String(auditError),
    });
  }

  return {
    id: created.id,
    version,
    baselineType: input.baselineType,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    metrics,
    revenueDays: revenueRows.length,
    socialPosts: socialRows.length,
    unmeasuredDimensions,
    frozenAt,
  };
}
