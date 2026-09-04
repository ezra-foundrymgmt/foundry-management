import type { DataConfidence, MetricPoint } from "./types";

/**
 * Works a revenue target backwards through the acquisition funnel.
 *
 * The question this answers is the one a founder actually asks: "we want
 * $40,000 from this creator next month — what has to be true?" Answering it
 * means inverting the funnel the daily report already measures forward:
 *
 *   reach -> profileVisits -> outboundClicks -> newSubscribers -> firstBuyers
 *   -> revenue
 *
 * Every stage division is a conversion rate measured from the creator's own
 * history. That is the whole reason this can be honest rather than a
 * spreadsheet fantasy — and also the reason it must refuse.
 *
 * THE REFUSAL IS THE POINT. A plan is only as real as the rates behind it. If
 * a creator's reach has never been ingested, the reach->profileVisits rate
 * cannot be computed, and inventing one (an "industry average", a round
 * number, last quarter's) produces a required-reach figure that looks precise,
 * gets put in front of a creator, and is fiction. Every stage therefore
 * carries its own provenance and an unmeasurable stage is reported as
 * unmeasurable rather than filled in. That is "unknown is not zero" applied to
 * planning: an absent rate must not become an assumed one.
 */

/** One inverted funnel step, and how much the number behind it can be trusted. */
export interface PlannedStage {
  stage: FunnelStage;
  /** How many of this thing the target implies. Null when unknowable. */
  required: number | null;
  /** The measured conversion from this stage to the next, as a rate in (0,1]. */
  conversionRate: number | null;
  confidence: DataConfidence;
  /** Present only when `required` is null: why the stage could not be planned. */
  blockedBy?: "RATE_NOT_MEASURED" | "RATE_IS_ZERO" | "UPSTREAM_UNKNOWN";
}

export const FUNNEL_STAGES = [
  "reach",
  "profileVisits",
  "outboundClicks",
  "newSubscribers",
  "firstBuyers",
] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export interface RevenuePlan {
  targetRevenue: number;
  /** Revenue per first-time buyer, measured. Null when unmeasurable. */
  revenuePerFirstBuyer: number | null;
  stages: PlannedStage[];
  /**
   * True only when every stage produced a number. A partial plan is still
   * worth showing — the stages nearest the money are usually measurable even
   * when reach is not — but it must never be presented as a complete one.
   */
  complete: boolean;
  /** Stages that could not be planned, in funnel order. Empty when complete. */
  unplannable: FunnelStage[];
}

/**
 * A rate is only meaningful if BOTH sides of it were measured.
 *
 * Returns null rather than 0 for an unmeasured or zero denominator. A zero
 * conversion rate would make the inverted requirement infinite, and a null one
 * correctly says "this cannot be planned from what we know".
 */
function rate(numerator: number, denominator: number, measured: boolean): number | null {
  if (!measured) return null;
  if (denominator <= 0) return null;
  if (numerator <= 0) return null;
  return numerator / denominator;
}

export interface PlanInput {
  targetRevenue: number;
  /** A measured window of the creator's own funnel — usually the frozen baseline. */
  measured: MetricPoint;
  /**
   * Dimensions in `measured` that were never actually measured, exactly as
   * `freezeBaseline` records them. A dimension listed here reads as 0 in the
   * MetricPoint, and treating that 0 as a measurement is what this exists to
   * prevent.
   */
  unmeasuredDimensions?: readonly string[];
  /** Confidence of the underlying measurements, from the import that fed them. */
  dataConfidence: DataConfidence;
  /**
   * Multipliers applied to the MEASURED conversion rates, keyed by the stage
   * each rate converts from. Used by scenarios; absent stages keep their
   * measured rate.
   *
   * Applied to the rates rather than to the underlying volumes. Scaling a
   * volume looks equivalent and is not: raising `profileVisits` improves
   * reach->profileVisits and degrades profileVisits->outboundClicks by exactly
   * the same factor, so the two cancel and the required reach never moves. A
   * scenario has to name a rate, because a rate is what it is a claim about.
   */
  rateMultipliers?: Partial<Record<FunnelStage, number>>;
}

/**
 * Builds the plan.
 *
 * Works from the money backwards, because that is the direction the
 * requirement flows: the target implies buyers, buyers imply subscribers, and
 * so on up to reach. The moment a stage cannot be computed, everything
 * upstream of it becomes UPSTREAM_UNKNOWN — not because the rate is missing
 * there too, but because there is no longer a downstream requirement to
 * multiply up. Reporting those as UPSTREAM_UNKNOWN rather than
 * RATE_NOT_MEASURED tells the operator which measurement would actually
 * unblock the plan.
 */
export function planRevenueTarget(input: PlanInput): RevenuePlan {
  const unmeasured = new Set(input.unmeasuredDimensions ?? []);
  const measuredAt = (dimension: string) => !unmeasured.has(dimension);
  const point = input.measured;

  const revenuePerFirstBuyer = rate(
    point.revenue,
    point.firstBuyers,
    measuredAt("revenue") && measuredAt("firstBuyers"),
  );

  /**
   * Conversion from each stage to the one below it, measured. Indexed by the
   * stage the rate converts FROM, so `conversions.reach` is
   * profileVisits/reach.
   */
  const conversions: Record<FunnelStage, number | null> = {
    reach: rate(point.profileVisits, point.reach, measuredAt("reach") && measuredAt("profileVisits")),
    profileVisits: rate(
      point.outboundClicks,
      point.profileVisits,
      measuredAt("profileVisits") && measuredAt("outboundClicks"),
    ),
    outboundClicks: rate(
      point.newSubscribers,
      point.outboundClicks,
      measuredAt("outboundClicks") && measuredAt("newSubscribers"),
    ),
    newSubscribers: rate(
      point.firstBuyers,
      point.newSubscribers,
      measuredAt("newSubscribers") && measuredAt("firstBuyers"),
    ),
    // The last stage converts to money, not to another volume.
    firstBuyers: revenuePerFirstBuyer,
  };

  /**
   * Scenario multipliers, applied here so they bend a measured rate and
   * nothing else. A null rate stays null however large the multiplier: a
   * scenario cannot rescue a stage nobody measured, and letting it appear to
   * would manufacture a plan for a creator whose reach has never been ingested.
   */
  for (const stage of FUNNEL_STAGES) {
    const multiplier = input.rateMultipliers?.[stage];
    const current = conversions[stage];
    if (multiplier === undefined || current === null) continue;
    conversions[stage] = current * multiplier;
  }

  const stages: PlannedStage[] = [];

  /**
   * Buyers implied by the target.
   *
   * Read from `conversions`, not from `revenuePerFirstBuyer` directly, so a
   * scenario on the firstBuyers stage ("what if each buyer were worth 20%
   * more") actually moves the plan. Using the raw measured value here made
   * that one scenario silently do nothing while every other stage responded.
   */
  const effectiveRevenuePerBuyer = conversions.firstBuyers;
  let downstreamRequirement: number | null =
    effectiveRevenuePerBuyer === null ? null : input.targetRevenue / effectiveRevenuePerBuyer;

  let upstreamBlocked = false;
  // Walk the funnel from the money upwards.
  for (const stage of [...FUNNEL_STAGES].reverse()) {
    const conversion = conversions[stage];

    if (stage === "firstBuyers") {
      stages.push({
        stage,
        required: downstreamRequirement === null ? null : Math.ceil(downstreamRequirement),
        conversionRate: effectiveRevenuePerBuyer,
        confidence: effectiveRevenuePerBuyer === null ? "UNKNOWN" : input.dataConfidence,
        ...(downstreamRequirement === null ? { blockedBy: "RATE_NOT_MEASURED" as const } : {}),
      });
      if (downstreamRequirement === null) upstreamBlocked = true;
      continue;
    }

    if (upstreamBlocked) {
      stages.push({
        stage,
        required: null,
        conversionRate: conversion,
        confidence: "UNKNOWN",
        blockedBy: "UPSTREAM_UNKNOWN",
      });
      continue;
    }

    if (conversion === null) {
      stages.push({
        stage,
        required: null,
        conversionRate: null,
        confidence: "UNKNOWN",
        blockedBy: "RATE_NOT_MEASURED",
      });
      upstreamBlocked = true;
      downstreamRequirement = null;
      continue;
    }

    downstreamRequirement = (downstreamRequirement as number) / conversion;
    stages.push({
      stage,
      required: Math.ceil(downstreamRequirement),
      conversionRate: conversion,
      confidence: input.dataConfidence,
    });
  }

  stages.reverse();
  const unplannable = stages.filter((s) => s.required === null).map((s) => s.stage);

  return {
    targetRevenue: input.targetRevenue,
    revenuePerFirstBuyer,
    stages,
    complete: unplannable.length === 0,
    unplannable,
  };
}

/**
 * A named what-if, expressed as multipliers on measured rates.
 *
 * Scenarios are deliberately multiplicative on the creator's OWN measured
 * rates rather than absolute targets typed by an operator. "Conversion
 * improves 10%" is a claim anchored to something real; "conversion becomes 4%"
 * is a number someone made up, and once it is in the plan nothing distinguishes
 * it from a measurement.
 */
export interface Scenario {
  name: string;
  /** Multiplier per stage conversion. Absent stages keep their measured rate. */
  rateMultipliers?: Partial<Record<FunnelStage, number>>;
}

export interface ScenarioResult {
  name: string;
  plan: RevenuePlan;
}

/**
 * Runs a plan under each scenario.
 *
 * A scenario cannot rescue an unmeasured rate: multiplying null is still null.
 * That is intentional — otherwise "what if reach converted 20% better" would
 * silently manufacture a reach plan for a creator whose reach has never been
 * measured at all.
 */
export function planScenarios(input: PlanInput, scenarios: readonly Scenario[]): ScenarioResult[] {
  return scenarios.map((scenario) => ({
    name: scenario.name,
    plan: planRevenueTarget({
      ...input,
      ...(scenario.rateMultipliers ? { rateMultipliers: scenario.rateMultipliers } : {}),
    }),
  }));
}

/** Where a creator stands against a target partway through a period. */
export interface GoalPace {
  targetRevenue: number;
  achievedRevenue: number;
  /** Share of the period elapsed, 0..1. */
  elapsedFraction: number;
  /** What should have been earned by now at an even run rate. */
  expectedByNow: number;
  /** Positive means ahead. */
  varianceToDate: number;
  /** Per remaining day, to still hit the target. Null when no days remain. */
  requiredDailyRunRate: number | null;
  status: "AHEAD" | "ON_TRACK" | "BEHIND" | "TARGET_MET" | "PERIOD_COMPLETE_MISSED";
}

/**
 * Paces revenue against a goal.
 *
 * Even run-rate rather than a seasonality curve: this team has no
 * seasonality model, and inventing one would dress an assumption as a
 * measurement — the same failure this module exists to avoid. When there is a
 * measured seasonal shape to use, this is where it goes.
 */
export function paceAgainstGoal(input: {
  targetRevenue: number;
  achievedRevenue: number;
  elapsedDays: number;
  periodDays: number;
  /** Tolerance before calling a creator behind or ahead. Defaults to 5%. */
  toleranceFraction?: number;
}): GoalPace {
  const periodDays = Math.max(1, input.periodDays);
  const elapsedDays = Math.min(Math.max(0, input.elapsedDays), periodDays);
  const elapsedFraction = elapsedDays / periodDays;
  const expectedByNow = input.targetRevenue * elapsedFraction;
  const varianceToDate = input.achievedRevenue - expectedByNow;
  const remainingDays = periodDays - elapsedDays;
  const remainingRevenue = Math.max(0, input.targetRevenue - input.achievedRevenue);
  const tolerance = input.toleranceFraction ?? 0.05;

  const status: GoalPace["status"] =
    input.achievedRevenue >= input.targetRevenue
      ? "TARGET_MET"
      : remainingDays === 0
        ? "PERIOD_COMPLETE_MISSED"
        : varianceToDate > input.targetRevenue * tolerance
          ? "AHEAD"
          : varianceToDate < -input.targetRevenue * tolerance
            ? "BEHIND"
            : "ON_TRACK";

  return {
    targetRevenue: input.targetRevenue,
    achievedRevenue: input.achievedRevenue,
    elapsedFraction,
    expectedByNow,
    varianceToDate,
    // Null rather than Infinity when the period is over: there is no run rate
    // that reaches the target, and a number here would imply there is.
    requiredDailyRunRate: remainingDays === 0 ? null : remainingRevenue / remainingDays,
    status,
  };
}
