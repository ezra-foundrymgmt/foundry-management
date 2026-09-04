import "server-only";
import { z } from "zod";
import {
  paceAgainstGoal,
  planScenarios,
  planRevenueTarget,
  type DataConfidence,
  type GoalPace,
  type RevenuePlan,
  type ScenarioResult,
} from "@creatoros/domain";
import type { AppSession } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { logEvent } from "@/lib/observability";
import { preferOneRowPerPeriod } from "@/lib/metric-rows";

/**
 * Assembles a revenue plan from the creator's own measured history.
 *
 * The inputs come from the frozen baseline rather than from a typed form,
 * which is the entire reason the plan can be trusted: a baseline is computed
 * from measured rows, versioned, and carries its own record of which
 * dimensions were never measured. That record is passed straight through to
 * the planner, so a creator whose reach has never been ingested gets a plan
 * that says so instead of a required-reach figure nobody could stand behind.
 */

const metricsSchema = z.object({
  date: z.string(),
  reach: z.coerce.number(),
  profileVisits: z.coerce.number(),
  outboundClicks: z.coerce.number(),
  newSubscribers: z.coerce.number(),
  firstBuyers: z.coerce.number(),
  revenue: z.coerce.number(),
  unmeasuredDimensions: z.array(z.string()).default([]),
});

export const planRequestSchema = z.object({
  targetRevenue: z.number().positive().max(100_000_000),
  /** The period the target applies to, used for pacing. */
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Which baseline to plan from. Matches freezeBaseline's own default. */
  baselineType: z.string().trim().min(1).max(40).default("ROLLING_30D"),
});

export class PlannerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function admin() {
  const client = createSupabaseAdminClient();
  if (!client) throw new PlannerError("DATABASE_NOT_CONFIGURED", 503);
  return client;
}

function databaseFailure(operation: string, error: { message: string }): PlannerError {
  logEvent("error", "planner.database_failed", { operation, message: error.message });
  return new PlannerError("PLANNER_DATABASE_FAILED", 500);
}

/** Inclusive day count, matching how the report measures a period. */
function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
}

export interface CreatorRevenuePlan {
  creatorId: string;
  baselineVersion: number;
  baselineType: string;
  baselinePeriod: { start: string; end: string };
  plan: RevenuePlan;
  scenarios: ScenarioResult[];
  pace: GoalPace;
  /** What the pacing was measured from, so the figure can be audited. */
  achievedFrom: { rows: number; source: "creator_revenue_daily" };
}

/**
 * The standing what-ifs.
 *
 * Deliberately modest multipliers on the creator's OWN measured rates. A
 * scenario that doubles a conversion rate is not a plan, it is a wish, and
 * once it renders beside the measured plan nothing distinguishes them.
 */
const SCENARIOS = [
  { name: "Visit rate +10%", rateMultipliers: { reach: 1.1 } },
  { name: "Subscribe rate +10%", rateMultipliers: { outboundClicks: 1.1 } },
  { name: "Buyer value +10%", rateMultipliers: { firstBuyers: 1.1 } },
] as const;

export async function buildCreatorRevenuePlan(
  session: AppSession,
  creatorId: string,
  input: z.infer<typeof planRequestSchema>,
): Promise<CreatorRevenuePlan> {
  if (input.periodStart > input.periodEnd) throw new PlannerError("PERIOD_START_AFTER_END", 400);
  const client = admin();

  const creator = await client
    .from("creators")
    .select("id")
    .eq("organization_id", session.organizationId)
    .eq("id", creatorId)
    .maybeSingle();
  if (creator.error) throw databaseFailure("creator-lookup", creator.error);
  if (!creator.data) throw new PlannerError("CREATOR_NOT_FOUND", 404);

  /**
   * The latest baseline OF ONE TYPE.
   *
   * `creator_baselines` is unique(creator_id, baseline_type, version), so
   * versions restart per type. Ordering by version alone across every type
   * therefore returns whichever type happens to have the highest number — a
   * QUARTERLY at v5 would beat the ROLLING_30D at v3 that the operator meant,
   * and nothing in the response would say which one the plan came from.
   * Pinning the type makes the answer deterministic, and it is echoed back so
   * the figure can be audited.
   */
  const baseline = await client
    .from("creator_baselines")
    .select("metrics_json,period_start,period_end,version,baseline_type")
    .eq("organization_id", session.organizationId)
    .eq("creator_id", creatorId)
    .eq("baseline_type", input.baselineType)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (baseline.error) throw databaseFailure("baseline-read", baseline.error);

  const row = baseline.data as {
    metrics_json?: unknown;
    period_start?: string;
    period_end?: string;
    version?: number;
    baseline_type?: string;
  } | null;
  const metrics = metricsSchema.safeParse(row?.metrics_json);
  /**
   * Refused rather than defaulted. Without a baseline there are no measured
   * conversion rates, and a plan assembled from nothing would be a column of
   * confident numbers with no measurement anywhere behind it.
   */
  if (!metrics.success) throw new PlannerError("NO_BASELINE_FROZEN", 409);

  // What the creator has actually earned inside the target period so far.
  const achieved = await client
    .from("creator_revenue_daily")
    .select("date,platform,imported_at,data_confidence,creator_platform_receipts")
    .eq("organization_id", session.organizationId)
    .eq("creator_id", creatorId)
    .gte("date", input.periodStart)
    .lte("date", input.periodEnd)
    .order("imported_at", { ascending: true });
  if (achieved.error) throw databaseFailure("achieved-read", achieved.error);

  const achievedRows = preferOneRowPerPeriod(
    z
      .array(
        z.object({
          date: z.string(),
          platform: z.string().nullable().optional(),
          imported_at: z.string().nullable().optional(),
          data_confidence: z.string().nullable().optional(),
          creator_platform_receipts: z.coerce.number().nullable(),
        }),
      )
      .parse(achieved.data ?? []),
    (entry) => `${entry.date}|${entry.platform ?? ""}`,
  );
  const achievedRevenue = achievedRows.reduce(
    (total, entry) => total + (entry.creator_platform_receipts ?? 0),
    0,
  );

  /**
   * The plan is only as confident as the weakest measurement behind the
   * baseline. `freezeBaseline` does not record a confidence of its own, so
   * this is derived from the rows inside the target period — the closest
   * honest proxy available — and falls back to UNKNOWN when there are none.
   */
  const dataConfidence: DataConfidence = weakest(
    achievedRows.map((entry) => entry.data_confidence),
  );

  const planInput = {
    targetRevenue: input.targetRevenue,
    measured: metrics.data,
    unmeasuredDimensions: metrics.data.unmeasuredDimensions,
    dataConfidence,
  };

  const periodDays = daysBetween(input.periodStart, input.periodEnd);
  const today = new Date().toISOString().slice(0, 10);
  const elapsedDays =
    today < input.periodStart ? 0 : daysBetween(input.periodStart, today > input.periodEnd ? input.periodEnd : today);

  return {
    creatorId,
    baselineVersion: row?.version ?? 0,
    baselineType: row?.baseline_type ?? input.baselineType,
    baselinePeriod: { start: row?.period_start ?? "", end: row?.period_end ?? "" },
    plan: planRevenueTarget(planInput),
    scenarios: planScenarios(planInput, SCENARIOS),
    pace: paceAgainstGoal({
      targetRevenue: input.targetRevenue,
      achievedRevenue,
      elapsedDays,
      periodDays,
    }),
    achievedFrom: { rows: achievedRows.length, source: "creator_revenue_daily" },
  };
}

/** Weakest-wins, matching how the daily report qualifies its own figures. */
function weakest(values: ReadonlyArray<string | null | undefined>): DataConfidence {
  const ordered: readonly DataConfidence[] = [
    "UNKNOWN",
    "ESTIMATED",
    "PARTIALLY_MEASURED",
    "MEASURED",
  ];
  if (values.length === 0) return "UNKNOWN";
  let index = ordered.length - 1;
  for (const value of values) {
    const found = ordered.indexOf((value ?? "UNKNOWN") as DataConfidence);
    index = Math.min(index, found === -1 ? 0 : found);
  }
  return ordered[index] ?? "UNKNOWN";
}
