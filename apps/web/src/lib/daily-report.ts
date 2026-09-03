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

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
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
    .select("id,stage_name,current_health_score")
    .eq("organization_id", input.organizationId)
    .eq("id", input.creatorId)
    .maybeSingle();
  if (creatorResult.error) throw new Error(`CREATOR_READ_FAILED: ${creatorResult.error.message}`);
  const creator = creatorRowSchema.safeParse(creatorResult.data);
  if (!creator.success) return { produced: false, reason: "CREATOR_NOT_FOUND" };

  const baselineResult = await client
    .from("creator_baselines")
    .select("metrics_json")
    .eq("organization_id", input.organizationId)
    .eq("creator_id", input.creatorId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (baselineResult.error)
    throw new Error(`BASELINE_READ_FAILED: ${baselineResult.error.message}`);
  const baseline = metricPointSchema.safeParse(
    (baselineResult.data as { metrics_json?: unknown } | null)?.metrics_json,
  );
  // Refusing here is the whole point: the rules engine reports change against a
  // baseline, and without one there is nothing to compare to.
  if (!baseline.success) return { produced: false, reason: "NO_BASELINE_FROZEN" };

  const since = isoDaysAgo(7);
  const [revenue, social] = await Promise.all([
    client
      .from("creator_revenue_daily")
      .select("date,creator_platform_receipts,new_subscribers,first_buyers")
      .eq("organization_id", input.organizationId)
      .eq("creator_id", input.creatorId)
      .gte("date", since),
    client
      .from("social_posts")
      .select("reach,profile_visits,outbound_clicks")
      .eq("organization_id", input.organizationId)
      .eq("creator_id", input.creatorId)
      .gte("published_at", `${since}T00:00:00.000Z`),
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

  const report = generateDailyReport({
    creatorId: input.creatorId,
    reportDate,
    current,
    baseline: baseline.data,
    healthBand: healthBand(creator.data.current_health_score ?? 0),
    contentBufferDays: 0,
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
