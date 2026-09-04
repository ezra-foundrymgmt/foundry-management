import { describe, expect, it } from "vitest";
import { paceAgainstGoal, planRevenueTarget, planScenarios } from "./revenue-plan";
import type { MetricPoint } from "./types";

/**
 * The planner's value is what it REFUSES to compute. A funnel plan built on an
 * assumed conversion rate looks exactly like one built on a measured rate, and
 * gets put in front of a creator as a commitment.
 */

/** A fully measured 30-day window: 1% visit rate, 20% click, 10% sub, 25% buy. */
const measured: MetricPoint = {
  date: "2026-08-31",
  reach: 1_000_000,
  profileVisits: 10_000,
  outboundClicks: 2_000,
  newSubscribers: 200,
  firstBuyers: 50,
  revenue: 5_000,
};

describe("planning backwards from a revenue target", () => {
  it("inverts the funnel from measured rates", () => {
    // $5000 / 50 buyers = $100 per buyer, so $10,000 needs 100 buyers.
    const plan = planRevenueTarget({
      targetRevenue: 10_000,
      measured,
      dataConfidence: "MEASURED",
    });

    expect(plan.revenuePerFirstBuyer).toBe(100);
    expect(plan.complete).toBe(true);

    const required = Object.fromEntries(plan.stages.map((s) => [s.stage, s.required]));
    expect(required["firstBuyers"]).toBe(100);
    // 100 buyers / 0.25 = 400 subscribers
    expect(required["newSubscribers"]).toBe(400);
    // 400 / 0.10 = 4000 clicks
    expect(required["outboundClicks"]).toBe(4_000);
    // 4000 / 0.20 = 20000 visits
    expect(required["profileVisits"]).toBe(20_000);
    // 20000 / 0.01 = 2,000,000 reach
    expect(required["reach"]).toBe(2_000_000);
  });

  it("keeps the stages in funnel order, reach first", () => {
    const plan = planRevenueTarget({ targetRevenue: 10_000, measured, dataConfidence: "MEASURED" });
    expect(plan.stages.map((s) => s.stage)).toEqual([
      "reach",
      "profileVisits",
      "outboundClicks",
      "newSubscribers",
      "firstBuyers",
    ]);
  });

  it("carries the measurement confidence onto every planned stage", () => {
    const plan = planRevenueTarget({
      targetRevenue: 10_000,
      measured,
      dataConfidence: "ESTIMATED",
    });
    for (const stage of plan.stages) expect(stage.confidence).toBe("ESTIMATED");
  });
});

describe("a stage nobody measured is refused, not assumed", () => {
  it("refuses the reach stage when reach was never ingested", () => {
    // Exactly the state of every creator today: freezeBaseline stored reach 0
    // and named it unmeasured, because social_posts had no writer.
    const plan = planRevenueTarget({
      targetRevenue: 10_000,
      measured: { ...measured, reach: 0, profileVisits: 0, outboundClicks: 0 },
      unmeasuredDimensions: ["reach", "profileVisits", "outboundClicks"],
      dataConfidence: "MEASURED",
    });

    expect(plan.complete).toBe(false);
    const byStage = Object.fromEntries(plan.stages.map((s) => [s.stage, s]));

    // The money end still plans: that is the useful half.
    expect(byStage["firstBuyers"]?.required).toBe(100);
    expect(byStage["newSubscribers"]?.required).toBe(400);

    // The unmeasured end refuses rather than inventing a required reach.
    expect(byStage["outboundClicks"]?.required).toBeNull();
    expect(byStage["reach"]?.required).toBeNull();
  });

  it("distinguishes the stage that is actually missing from the ones blocked behind it", () => {
    // Naming every unplannable stage RATE_NOT_MEASURED would hide which single
    // measurement would unblock the plan.
    const plan = planRevenueTarget({
      targetRevenue: 10_000,
      measured: { ...measured, reach: 0, profileVisits: 0, outboundClicks: 0 },
      unmeasuredDimensions: ["reach", "profileVisits", "outboundClicks"],
      dataConfidence: "MEASURED",
    });
    const byStage = Object.fromEntries(plan.stages.map((s) => [s.stage, s]));
    expect(byStage["outboundClicks"]?.blockedBy).toBe("RATE_NOT_MEASURED");
    expect(byStage["profileVisits"]?.blockedBy).toBe("UPSTREAM_UNKNOWN");
    expect(byStage["reach"]?.blockedBy).toBe("UPSTREAM_UNKNOWN");
  });

  it("refuses the whole plan when revenue per buyer cannot be measured", () => {
    const plan = planRevenueTarget({
      targetRevenue: 10_000,
      measured: { ...measured, firstBuyers: 0 },
      dataConfidence: "MEASURED",
    });
    expect(plan.revenuePerFirstBuyer).toBeNull();
    expect(plan.complete).toBe(false);
    // Everything is unplannable: without a value per buyer there is no anchor.
    expect(plan.unplannable).toHaveLength(5);
  });

  it("treats a zero denominator as unmeasurable rather than dividing by it", () => {
    const plan = planRevenueTarget({
      targetRevenue: 10_000,
      measured: { ...measured, reach: 0 },
      dataConfidence: "MEASURED",
    });
    const reach = plan.stages.find((s) => s.stage === "reach");
    expect(reach?.required).toBeNull();
    expect(reach?.conversionRate).toBeNull();
    // Never Infinity or NaN, which would render as a real-looking figure.
    for (const stage of plan.stages)
      expect(stage.required === null || Number.isFinite(stage.required)).toBe(true);
  });

  it("marks a refused stage UNKNOWN even when the data confidence is MEASURED", () => {
    const plan = planRevenueTarget({
      targetRevenue: 10_000,
      measured: { ...measured, reach: 0 },
      unmeasuredDimensions: ["reach"],
      dataConfidence: "MEASURED",
    });
    expect(plan.stages.find((s) => s.stage === "reach")?.confidence).toBe("UNKNOWN");
  });
});

describe("scenarios bend measured rates rather than replacing them", () => {
  it("reduces the required reach when conversion improves", () => {
    const base = planRevenueTarget({
      targetRevenue: 10_000,
      measured,
      dataConfidence: "MEASURED",
    });
    const [improved] = planScenarios(
      { targetRevenue: 10_000, measured, dataConfidence: "MEASURED" },
      [{ name: "Visit rate +20%", rateMultipliers: { reach: 1.2 } }],
    );

    const reachOf = (plan: typeof base) =>
      plan.stages.find((s) => s.stage === "reach")?.required ?? 0;
    expect(reachOf(improved!.plan)).toBeLessThan(reachOf(base));
  });

  it("cannot rescue an unmeasured stage", () => {
    // Otherwise "what if reach converted 20% better" would manufacture a reach
    // plan for a creator whose reach has never been measured at all.
    const [scenario] = planScenarios(
      {
        targetRevenue: 10_000,
        measured: { ...measured, reach: 0, profileVisits: 0, outboundClicks: 0 },
        unmeasuredDimensions: ["reach", "profileVisits", "outboundClicks"],
        dataConfidence: "MEASURED",
      },
      [{ name: "Reach converts twice as well", rateMultipliers: { reach: 2 } }],
    );
    expect(scenario!.plan.stages.find((s) => s.stage === "reach")?.required).toBeNull();
  });

  it("leaves the baseline plan untouched", () => {
    const input = { targetRevenue: 10_000, measured, dataConfidence: "MEASURED" as const };
    planScenarios(input, [{ name: "x", rateMultipliers: { reach: 5 } }]);
    // The scenario must not have mutated the caller's MetricPoint.
    expect(input.measured.profileVisits).toBe(10_000);
  });
});

describe("pacing against a goal", () => {
  it("reports on track when revenue matches the elapsed share", () => {
    const pace = paceAgainstGoal({
      targetRevenue: 30_000,
      achievedRevenue: 10_000,
      elapsedDays: 10,
      periodDays: 30,
    });
    expect(pace.expectedByNow).toBe(10_000);
    expect(pace.varianceToDate).toBe(0);
    expect(pace.status).toBe("ON_TRACK");
    expect(pace.requiredDailyRunRate).toBe(1_000);
  });

  it("reports behind, and says what the remaining days must produce", () => {
    const pace = paceAgainstGoal({
      targetRevenue: 30_000,
      achievedRevenue: 5_000,
      elapsedDays: 15,
      periodDays: 30,
    });
    expect(pace.status).toBe("BEHIND");
    // $25,000 left over 15 days.
    expect(pace.requiredDailyRunRate).toBeCloseTo(1_666.67, 1);
  });

  it("reports the target met rather than merely ahead", () => {
    const pace = paceAgainstGoal({
      targetRevenue: 30_000,
      achievedRevenue: 31_000,
      elapsedDays: 20,
      periodDays: 30,
    });
    expect(pace.status).toBe("TARGET_MET");
  });

  it("gives no run rate once the period is over, rather than an infinite one", () => {
    const pace = paceAgainstGoal({
      targetRevenue: 30_000,
      achievedRevenue: 20_000,
      elapsedDays: 30,
      periodDays: 30,
    });
    expect(pace.status).toBe("PERIOD_COMPLETE_MISSED");
    // A number here would imply a rate that could still reach the target.
    expect(pace.requiredDailyRunRate).toBeNull();
  });

  it("does not divide by zero for a zero-day period", () => {
    const pace = paceAgainstGoal({
      targetRevenue: 30_000,
      achievedRevenue: 0,
      elapsedDays: 0,
      periodDays: 0,
    });
    expect(Number.isFinite(pace.expectedByNow)).toBe(true);
  });

  it("clamps an elapsed count beyond the period rather than reporting past 100%", () => {
    const pace = paceAgainstGoal({
      targetRevenue: 30_000,
      achievedRevenue: 1_000,
      elapsedDays: 45,
      periodDays: 30,
    });
    expect(pace.elapsedFraction).toBe(1);
  });
});

describe("a scenario on the money stage moves the plan", () => {
  it("reduces required buyers when each buyer is worth more", () => {
    // Regression: the initial requirement was computed from the raw measured
    // revenue-per-buyer rather than the scenario-adjusted rate, so this one
    // scenario silently did nothing while every other stage responded.
    const [scenario] = planScenarios(
      { targetRevenue: 10_000, measured, dataConfidence: "MEASURED" },
      [{ name: "Each buyer worth 25% more", rateMultipliers: { firstBuyers: 1.25 } }],
    );
    const buyers = scenario!.plan.stages.find((s) => s.stage === "firstBuyers");
    // $100 -> $125 per buyer, so 100 buyers becomes 80.
    expect(buyers?.required).toBe(80);
    expect(buyers?.conversionRate).toBe(125);
    // ...and the requirement propagates all the way up the funnel.
    expect(scenario!.plan.stages.find((s) => s.stage === "reach")?.required).toBe(1_600_000);
  });
});

/**
 * "Never measured" and "measured zero" are different facts, and the difference
 * changes what the operator should do: the first means go and collect data,
 * the second means the offer converts nobody and no amount of extra traffic
 * fixes it. Both were reported as RATE_NOT_MEASURED.
 */
describe("a measured zero is distinguished from an absent measurement", () => {
  it("reports RATE_IS_ZERO when the creator measurably converted nobody", () => {
    // 2,000 clicks were measured, and they produced zero subscribers.
    const plan = planRevenueTarget({
      targetRevenue: 10_000,
      measured: { ...measured, newSubscribers: 0, firstBuyers: 0, revenue: 0 },
      dataConfidence: "MEASURED",
    });
    // The money stage cannot be valued, and says why: measured, and zero.
    expect(plan.stages.find((s) => s.stage === "firstBuyers")?.blockedBy).toBe("RATE_IS_ZERO");
  });

  it("still reports RATE_NOT_MEASURED when the dimension was never ingested", () => {
    const plan = planRevenueTarget({
      targetRevenue: 10_000,
      measured: { ...measured, reach: 0, profileVisits: 0, outboundClicks: 0 },
      unmeasuredDimensions: ["reach", "profileVisits", "outboundClicks"],
      dataConfidence: "MEASURED",
    });
    expect(plan.stages.find((s) => s.stage === "outboundClicks")?.blockedBy).toBe(
      "RATE_NOT_MEASURED",
    );
  });

  it("reports a measured-zero mid-funnel stage as zero, not as missing", () => {
    // Buyers and revenue measured, but zero subscribers were acquired, so the
    // newSubscribers -> firstBuyers rate has no input to convert.
    const plan = planRevenueTarget({
      targetRevenue: 10_000,
      measured: { ...measured, outboundClicks: 0, newSubscribers: 0, firstBuyers: 5, revenue: 500 },
      dataConfidence: "MEASURED",
    });
    expect(plan.stages.find((s) => s.stage === "newSubscribers")?.blockedBy).toBe("RATE_IS_ZERO");
    // Everything upstream is blocked behind it, not independently missing.
    expect(plan.stages.find((s) => s.stage === "reach")?.blockedBy).toBe("UPSTREAM_UNKNOWN");
    // ...and the stage below it still plans, because it was measurable.
    expect(plan.stages.find((s) => s.stage === "firstBuyers")?.required).toBe(100);
  });
});
