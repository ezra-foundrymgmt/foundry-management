import { describe, expect, it } from "vitest";
import {
  calculateFitScore,
  calculateHealthScore,
  classifyPerformance,
  generateDailyReport,
  performanceMultiplier,
  safeRate,
  hasPermission,
  calculateCreatorPnl,
} from "./index";

describe("FitScoreService", () => {
  it("calculates weighted score and tier", () => {
    const result = calculateFitScore({
      reliability: 92,
      audienceQuality: 86,
      marketFit: 84,
      productionCapacity: 88,
      monetizationHeadroom: 80,
      complianceBrandSafety: 94,
      coachability: 90,
    });
    expect(result.score).toBe(88);
    expect(result.tier).toBe("PRIORITY");
  });

  it("allows a disqualifier to override the score", () => {
    const result = calculateFitScore(
      {
        reliability: 100,
        audienceQuality: 100,
        marketFit: 100,
        productionCapacity: 100,
        monetizationHeadroom: 100,
        complianceBrandSafety: 100,
        coachability: 100,
      },
      ["AGE_NOT_CONFIRMED"],
    );
    expect(result.score).toBe(100);
    expect(result.tier).toBe("DISQUALIFIED");
  });
});

describe("RBAC", () => {
  it("allows super admins to start workflows", () =>
    expect(hasPermission("super_admin", "workflow.start")).toBe(true));
  it("prevents viewers from mutating creators", () =>
    expect(hasPermission("viewer", "creator.update")).toBe(false));
});

describe("HealthScoreService", () => {
  it("returns an explainable weighted score", () => {
    const result = calculateHealthScore({
      financial: 80,
      organicAcquisition: 70,
      creatorExecution: 90,
      fanMonetization: 65,
      fanRetention: 75,
      contentInventory: 60,
      creatorRelationship: 95,
      complianceSecurity: 100,
    });
    expect(result.score).toBe(78);
    expect(result.band).toBe("WATCH");
    expect(Object.keys(result.breakdown)).toHaveLength(8);
  });

  it("hard-overrides critical compliance incidents", () => {
    const result = calculateHealthScore(
      {
        financial: 100,
        organicAcquisition: 100,
        creatorExecution: 100,
        fanMonetization: 100,
        fanRetention: 100,
        contentInventory: 100,
        creatorRelationship: 100,
        complianceSecurity: 100,
      },
      true,
    );
    expect(result.score).toBe(100);
    expect(result.band).toBe("CRITICAL");
    expect(result.overridden).toBe(true);
  });
});

describe("creator-relative performance", () => {
  it("distinguishes an opportunity from a weak format", () => {
    expect(classifyPerformance(performanceMultiplier(220, 100))).toBe("OPPORTUNITY");
    expect(classifyPerformance(performanceMultiplier(63, 100))).toBe("WEAK");
  });

  it("reports no rolling median as unknown, not as a measured baseline", () => {
    // Regression: a null multiplier (no comparison history yet) used to
    // collapse into "BASELINE" -- the same label as a format that was
    // actually measured and came out unremarkable.
    expect(classifyPerformance(performanceMultiplier(220, null))).toBe("UNKNOWN");
    expect(classifyPerformance(null)).toBe("UNKNOWN");
  });

  it("avoids division-by-zero false precision", () => expect(safeRate(10, 0)).toBeNull());
});

describe("RevenueDiagnosticService", () => {
  it("identifies monetization—not traffic—as Madison's bottleneck", () => {
    const report = generateDailyReport({
      creatorId: "madison",
      reportDate: "2026-09-02",
      healthBand: "WATCH",
      contentBufferDays: 8,
      current: {
        date: "2026-09-02",
        reach: 186400,
        profileVisits: 5810,
        outboundClicks: 1241,
        newSubscribers: 63,
        firstBuyers: 18,
        revenue: 1482,
      },
      baseline: {
        date: "baseline",
        reach: 150300,
        profileVisits: 4435,
        outboundClicks: 1070,
        newSubscribers: 58,
        firstBuyers: 20,
        revenue: 1312,
      },
    });
    expect(report.primaryBottleneck).toBe("First-purchase monetization");
    expect(report.ruleId).toBe("DIAG-MONETIZATION-FIRST-PURCHASE-001");
    expect(report.recommendations[0]?.department).toBe("Revenue");
  });
});

describe("PnlService", () => {
  it("calculates Foundry revenue, direct cost, profit, and margin", () => {
    expect(
      calculateCreatorPnl({
        creatorPlatformReceipts: 50_000,
        commissionRate: 0.35,
        fanOpsLabor: 2_800,
        creatorSuccessLabor: 1_100,
        editingCost: 900,
        growthLabor: 1_200,
        creatorSpecificSoftware: 250,
        promotionCost: 500,
        paidTrafficCost: 400,
        contractorCost: 200,
        otherDirectCost: 164,
      }),
    ).toEqual({
      foundryRevenue: 17_500,
      directCost: 7_514,
      contributionProfit: 9_986,
      contributionMargin: 9_986 / 17_500,
    });
  });

  it("returns null margin when Foundry revenue is zero", () => {
    const result = calculateCreatorPnl({
      creatorPlatformReceipts: 0,
      commissionRate: 0.35,
      fanOpsLabor: 0,
      creatorSuccessLabor: 0,
      editingCost: 0,
      growthLabor: 0,
      creatorSpecificSoftware: 0,
      promotionCost: 0,
      paidTrafficCost: 0,
      contractorCost: 0,
      otherDirectCost: 0,
    });
    expect(result.contributionMargin).toBeNull();
  });
});
