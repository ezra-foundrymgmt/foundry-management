import "server-only";
import { z } from "zod";
import { generateDailyReport, healthBand, type MetricPoint } from "@creatoros/domain";
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
  }),
);

const socialRowsSchema = z.array(
  z.object({
    reach: z.coerce.number().nullable(),
    profile_visits: z.coerce.number().nullable(),
    outbound_clicks: z.coerce.number().nullable(),
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
      .select("date,creator_platform_receipts,new_subscribers,first_buyers")
      .eq("organization_id", input.organizationId)
      .eq("creator_id", input.creatorId)
      .gte("date", since)
      .lte("date", until),
    client
      .from("social_posts")
      .select("reach,profile_visits,outbound_clicks")
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
  const comparable =
    baselineDays === null ? baseline.data : scaleMetricPoint(baseline.data, CURRENT_WINDOW_DAYS / baselineDays);

  const report = generateDailyReport({
    creatorId: input.creatorId,
    reportDate,
    current,
    baseline: comparable,
    healthBand: healthBand(creator.data.current_health_score),
    contentBufferDays: creator.data.current_content_buffer_days,
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
