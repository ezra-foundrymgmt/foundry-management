import "server-only";
import { z } from "zod";
import {
  generateDailyReport,
  healthBand,
  type DataConfidence,
  type MetricPoint,
} from "@creatoros/domain";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const metricPointSchema = z.object({
  date: z.string(),
  reach: z.coerce.number(),
  profileVisits: z.coerce.number(),
  outboundClicks: z.coerce.number(),
  newSubscribers: z.coerce.number(),
  firstBuyers: z.coerce.number(),
  revenue: z.coerce.number(),
});

const revenueRowsSchema = z.array(
  z.object({
    date: z.string(),
    creator_platform_receipts: z.coerce.number().nullable(),
    new_subscribers: z.coerce.number().nullable(),
    first_buyers: z.coerce.number().nullable(),
    data_confidence: z.string().nullable().optional(),
  }),
);

const socialRowsSchema = z.array(
  z.object({
    reach: z.coerce.number().nullable(),
    profile_visits: z.coerce.number().nullable(),
    outbound_clicks: z.coerce.number().nullable(),
    data_confidence: z.string().nullable().optional(),
  }),
);

const creatorRowSchema = z.object({
  id: z.string().uuid(),
  stage_name: z.string(),
  current_health_score: z.coerce.number().nullable(),
  current_content_buffer_days: z.coerce.number().nullable(),
});

/**
 * Why a report could not be produced. These are reported, not papered over: a
 * report generated without a baseline would be comparing against nothing and
 * every "change" in it would be an invention.
 */
export type DailyReportSkipReason =
  "CREATOR_NOT_FOUND" | "NO_BASELINE_FROZEN" | "NO_METRICS_FOR_PERIOD";

export type DailyReportOutcome =
  | { produced: true; reportId: string; reportDate: string; ruleId: string }
  | { produced: false; reason: DailyReportSkipReason };

function admin() {
  const client = createSupabaseAdminClient();
  if (!client) throw new Error("DATABASE_NOT_CONFIGURED");
  return client;
}

/**
 * The trailing window `current` is summed over, in calendar days.
 *
 * The declared window and the queried window must be equal, because the
 * baseline is scaled onto this number before the two are compared. They were
 * not: the constant said 7 while an unbounded `.gte(isoDaysAgo(7))` returned 8
 * dates, so a flat creator was reported as +14.29% — including on
 * `acquisitionChange`, which gates a real rule.
 */
const CURRENT_WINDOW_DAYS = 7;

function isoDate(instant: number): string {
  return new Date(instant).toISOString().slice(0, 10);
}

/**
 * The window the report covers: CURRENT_WINDOW_DAYS calendar days ending on the
 * report's own date, both bounds inclusive.
 *
 * Anchored to `reportDate` rather than to `Date.now()`. The scheduler dates
 * each report in the *creator's* timezone (`reportDateFor(now, timezone)`), so
 * at 22:00 UTC an Auckland creator's report is dated tomorrow while a Los
 * Angeles creator's is dated today. A window anchored to the server's UTC
 * "now" therefore summed a different seven days than the date printed on the
 * report — and `currentWindowDays: 7` in data_quality_json described a window
 * that did not end on the report date. It also made backfilling a past date
 * silently report the last seven days instead of the seven the caller asked
 * for.
 *
 * The upper bound is what makes the count exact. Without it the query is
 * "everything from `since` onwards", which picks up any row dated ahead of the
 * report — a creator east of UTC whose local date has already rolled over, or
 * a backfill — and the 7-vs-8 drift returns.
 */
function currentWindow(reportDate: string): { since: string; until: string } {
  const end = Date.parse(`${reportDate}T00:00:00.000Z`);
  return {
    since: isoDate(end - (CURRENT_WINDOW_DAYS - 1) * 86_400_000),
    until: reportDate,
  };
}

/**
 * Inclusive day count of a frozen baseline's period.
 *
 * Returns null when the period cannot be read, which makes the caller fall
 * back to comparing unscaled — wrong, but no more wrong than before, and
 * recorded in the report's data quality rather than hidden.
 */
function periodLengthInDays(start?: string | null, end?: string | null): number | null {
  if (!start || !end) return null;
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return Math.round((to - from) / 86_400_000) + 1;
}

/**
 * The weakest confidence among the rows that fed a report.
 *
 * A sum is only as trustworthy as its worst input: one ESTIMATED day inside a
 * seven-day window makes the total estimated, not measured. Ordered weakest
 * first so the first match wins.
 *
 * An unrecognised or absent value counts as UNKNOWN rather than being skipped.
 * The column is `not null default 'UNKNOWN'` in the schema, but these rows may
 * predate the import path entirely, and treating an unreadable provenance as
 * "fine" is the precise mistake this whole change exists to stop.
 */
function weakestConfidence(values: ReadonlyArray<string | null | undefined>): DataConfidence {
  const ordered: readonly DataConfidence[] = [
    "UNKNOWN",
    "ESTIMATED",
    "PARTIALLY_MEASURED",
    "MEASURED",
  ];
  if (values.length === 0) return "UNKNOWN";
  let weakest = ordered.length - 1;
  for (const value of values) {
    const index = ordered.indexOf((value ?? "UNKNOWN") as DataConfidence);
    weakest = Math.min(weakest, index === -1 ? 0 : index);
  }
  return ordered[weakest] ?? "UNKNOWN";
}

/** The comparison dimensions, split by the table that measures each. */
const SOCIAL_DIMENSIONS = ["reach", "profileVisits", "outboundClicks"] as const;
const REVENUE_DIMENSIONS = ["newSubscribers", "firstBuyers", "revenue"] as const;
type MetricDimension = (typeof SOCIAL_DIMENSIONS)[number] | (typeof REVENUE_DIMENSIONS)[number];

const ALL_DIMENSIONS: readonly string[] = [...SOCIAL_DIMENSIONS, ...REVENUE_DIMENSIONS];

function isMetricDimension(value: string): value is MetricDimension {
  return ALL_DIMENSIONS.includes(value);
}

/**
 * Reads the measurement provenance `freezeBaseline` stores beside the numbers.
 *
 * Tolerant on purpose: baselines frozen before that marker existed have no
 * such key, and they must still be readable. An absent marker is treated as
 * "nothing is known to be unmeasured", which is the pre-existing behaviour.
 */
const baselineUnmeasuredSchema = z.object({
  unmeasuredDimensions: z.array(z.string()).default([]),
});

/**
 * Zeroes the baseline for dimensions that cannot honestly be compared.
 *
 * A zero baseline is the rules engine's existing signal for "incomparable":
 * `percentChange` returns null for it and every rule requires a non-null
 * change. So this neutralises exactly those dimensions and leaves the rest
 * untouched.
 */
function withIncomparableDimensionsZeroed(
  point: MetricPoint,
  incomparable: ReadonlySet<MetricDimension>,
): MetricPoint {
  const zeroed = { ...point };
  for (const dimension of incomparable) zeroed[dimension] = 0;
  return zeroed;
}

/**
 * Scales a summed MetricPoint by a window ratio.
 *
 * `date` is carried through untouched: it labels the point, it is not a
 * quantity.
 */
function scaleMetricPoint(point: MetricPoint, factor: number): MetricPoint {
  return {
    date: point.date,
    reach: point.reach * factor,
    profileVisits: point.profileVisits * factor,
    outboundClicks: point.outboundClicks * factor,
    newSubscribers: point.newSubscribers * factor,
    firstBuyers: point.firstBuyers * factor,
    revenue: point.revenue * factor,
  };
}

/**
 * Produces one creator's daily report from real CreatorOS data and stores it.
 *
 * Every comparison is against the creator's own frozen baseline, never against
 * other creators. If no baseline has been frozen, or no metrics exist for the
 * window, no report is written — an absent measurement must not become a zero
 * that reads as a real result.
 */
export async function produceDailyCreatorReport(input: {
  organizationId: string;
  creatorId: string;
  reportDate?: string;
}): Promise<DailyReportOutcome> {
  const client = admin();
  const reportDate = input.reportDate ?? new Date().toISOString().slice(0, 10);

  const creatorResult = await client
    .from("creators")
    .select("id,stage_name,current_health_score,current_content_buffer_days")
    .eq("organization_id", input.organizationId)
    .eq("id", input.creatorId)
    .maybeSingle();
  if (creatorResult.error) throw new Error(`CREATOR_READ_FAILED: ${creatorResult.error.message}`);
  const creator = creatorRowSchema.safeParse(creatorResult.data);
  if (!creator.success) return { produced: false, reason: "CREATOR_NOT_FOUND" };

  const baselineResult = await client
    .from("creator_baselines")
    .select("metrics_json,period_start,period_end")
    .eq("organization_id", input.organizationId)
    .eq("creator_id", input.creatorId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (baselineResult.error)
    throw new Error(`BASELINE_READ_FAILED: ${baselineResult.error.message}`);
  const baselineRow = baselineResult.data as {
    metrics_json?: unknown;
    period_start?: string | null;
    period_end?: string | null;
  } | null;
  const baseline = metricPointSchema.safeParse(baselineRow?.metrics_json);
  // Refusing here is the whole point: the rules engine reports change against a
  // baseline, and without one there is nothing to compare to.
  if (!baseline.success) return { produced: false, reason: "NO_BASELINE_FROZEN" };

  const { since, until } = currentWindow(reportDate);
  const [revenue, social] = await Promise.all([
    client
      .from("creator_revenue_daily")
      .select("date,creator_platform_receipts,new_subscribers,first_buyers,data_confidence")
      .eq("organization_id", input.organizationId)
      .eq("creator_id", input.creatorId)
      .gte("date", since)
      .lte("date", until),
    client
      .from("social_posts")
      .select("reach,profile_visits,outbound_clicks,data_confidence")
      .eq("organization_id", input.organizationId)
      .eq("creator_id", input.creatorId)
      .gte("published_at", `${since}T00:00:00.000Z`)
      // `published_at` is an instant, not a date, so the upper bound is the
      // start of the day after `until` — exclusive, which covers every moment
      // of the final day without reaching into the next one.
      .lt("published_at", `${isoDate(Date.parse(`${until}T00:00:00.000Z`) + 86_400_000)}T00:00:00.000Z`),
  ]);
  if (revenue.error) throw new Error(`REVENUE_READ_FAILED: ${revenue.error.message}`);
  if (social.error) throw new Error(`SOCIAL_READ_FAILED: ${social.error.message}`);

  const revenueRows = revenueRowsSchema.parse(revenue.data ?? []);
  const socialRows = socialRowsSchema.parse(social.data ?? []);
  if (revenueRows.length === 0 && socialRows.length === 0)
    return { produced: false, reason: "NO_METRICS_FOR_PERIOD" };

  const current: MetricPoint = {
    date: reportDate,
    reach: socialRows.reduce((total, row) => total + (row.reach ?? 0), 0),
    profileVisits: socialRows.reduce((total, row) => total + (row.profile_visits ?? 0), 0),
    outboundClicks: socialRows.reduce((total, row) => total + (row.outbound_clicks ?? 0), 0),
    newSubscribers: revenueRows.reduce((total, row) => total + (row.new_subscribers ?? 0), 0),
    firstBuyers: revenueRows.reduce((total, row) => total + (row.first_buyers ?? 0), 0),
    revenue: revenueRows.reduce((total, row) => total + (row.creator_platform_receipts ?? 0), 0),
  };

  /**
   * Put both sides of the comparison on the same window before comparing.
   *
   * `current` is a 7-day sum. The baseline is a sum over whatever period was
   * frozen -- 30 days is the intended default. Comparing them directly made a
   * creator performing exactly at baseline look like a 77% collapse, which is
   * what the first real report produced: -73% revenue and -73% acquisition for
   * a creator whose daily numbers had not moved. The baseline's own
   * period_start/period_end were stored from the first migration and never
   * read.
   *
   * Scaling the baseline to the current window (rather than converting both to
   * per-day rates) keeps the rules engine's absolute thresholds -- 20 new
   * subscribers, 1000 reach -- meaningful against the window actually measured.
   */
  const baselineDays = periodLengthInDays(baselineRow?.period_start, baselineRow?.period_end);
  const scaled =
    baselineDays === null ? baseline.data : scaleMetricPoint(baseline.data, CURRENT_WINDOW_DAYS / baselineDays);

  /**
   * A dimension nobody measured must not be compared as though it read zero.
   *
   * Two ways that was happening, both of which get worse the moment a second
   * ingestion path exists:
   *
   * - The skip above fires only when BOTH dimensions are empty. So a creator
   *   with social data and no revenue data produced `revenue: 0`, and
   *   `percentChange(0, baselineRevenue)` is -100% -- a fabricated "revenue
   *   collapsed" bottleneck for a creator whose revenue was simply never
   *   ingested. Today social_posts is empty so this cannot fire; it fires on
   *   the first social row that lands.
   * - Symmetrically, every baseline frozen so far summed reach over an empty
   *   social table and stored 0. Once reach IS ingested, the current side
   *   climbs while the baseline stays 0.
   *
   * The fix reuses the convention the rules engine already has rather than
   * inventing one: `percentChange` returns null for a baseline of zero, and
   * every rule requires a non-null change. So zeroing the baseline for a
   * dimension that either side failed to measure makes that dimension
   * incomparable, which is exactly the truth -- and no rule can fire on it.
   */
  const unmeasuredNow = [
    ...(socialRows.length === 0 ? SOCIAL_DIMENSIONS : []),
    ...(revenueRows.length === 0 ? REVENUE_DIMENSIONS : []),
  ];
  const storedMarker = baselineUnmeasuredSchema.safeParse(baselineRow?.metrics_json);
  // Filtered rather than trusted: the marker is free-form JSON on a row that
  // may have been written by an older version of this code, and a value that
  // is not a real dimension must not silently zero one that is.
  const unmeasuredInBaseline = (
    storedMarker.success ? storedMarker.data.unmeasuredDimensions : []
  ).filter(isMetricDimension);
  const incomparable = new Set<MetricDimension>([...unmeasuredNow, ...unmeasuredInBaseline]);
  const comparable = withIncomparableDimensionsZeroed(scaled, incomparable);

  const dataConfidence = weakestConfidence([
    ...revenueRows.map((row) => row.data_confidence),
    ...socialRows.map((row) => row.data_confidence),
  ]);

  const report = generateDailyReport({
    creatorId: input.creatorId,
    reportDate,
    current,
    baseline: comparable,
    healthBand: healthBand(creator.data.current_health_score),
    contentBufferDays: creator.data.current_content_buffer_days,
    // Across BOTH tables: a recommendation drawing on either cannot claim
    // more confidence than the weakest row behind it.
    dataConfidence,
  });

  const { data, error } = await client
    .from("daily_creator_reports")
    .upsert(
      {
        organization_id: input.organizationId,
        creator_id: input.creatorId,
        report_date: reportDate,
        status: "READY",
        health_status: report.healthBand,
        summary: report.summary,
        primary_bottleneck: report.primaryBottleneck,
        priority: report.priority,
        metrics_json: report.metrics,
        anomalies_json: report.anomalies,
        recommendations_json: report.recommendations,
        // Records how confident the numbers are, so a reader can tell a report
        // built on partial data from one built on complete data.
        data_quality_json: {
          ruleId: report.ruleId,
          revenueDays: revenueRows.length,
          socialPosts: socialRows.length,
          comparisons: report.comparisons,
          // What the percentages were actually computed against, so a report
          // can explain its own comparison after the fact.
          currentWindowDays: CURRENT_WINDOW_DAYS,
          baselineWindowDays: baselineDays,
          baselineScaledToWindow: baselineDays !== null,
          /**
           * Which dimensions this report did NOT compare, and why. Without
           * this the report shows a percentage for some dimensions and
           * nothing for others with no way to tell an unmeasured dimension
           * from one that genuinely did not move.
           */
          unmeasuredThisWindow: unmeasuredNow,
          unmeasuredInBaseline,
          incomparableDimensions: [...incomparable],
          dataConfidence,
        },
        provider: "RULES",
      },
      { onConflict: "creator_id,report_date" },
    )
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`REPORT_WRITE_FAILED: ${error.message}`);

  return {
    produced: true,
    reportId: z.object({ id: z.string().uuid() }).parse(data).id,
    reportDate,
    ruleId: report.ruleId,
  };
}
