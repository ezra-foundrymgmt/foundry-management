import type { FitScoreComponents, FitTier } from "./types";

const weights: Record<keyof FitScoreComponents, number> = {
  reliability: 25,
  audienceQuality: 20,
  marketFit: 15,
  productionCapacity: 15,
  monetizationHeadroom: 10,
  complianceBrandSafety: 10,
  coachability: 5,
};

export const DISQUALIFYING_FLAGS = [
  "AGE_NOT_CONFIRMED",
  "CONFLICTING_MANAGEMENT_AGREEMENT",
  "HIDDEN_PLATFORM_ENFORCEMENT",
  "EXPECTS_GUARANTEED_INCOME",
  "EXPECTS_AGENCY_PAYOUT_OWNERSHIP",
  "REQUIRES_DECEPTIVE_MARKETING",
  "UNWILLING_TO_PRODUCE_CONTENT",
  "POLICY_CIRCUMVENTION_EXPECTATION",
] as const;

export type DisqualifyingFlag = (typeof DISQUALIFYING_FLAGS)[number];

function assertScore(value: number, key: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError(`${key} must be between 0 and 100`);
  }
}

export function calculateFitScore(
  components: FitScoreComponents,
  flags: DisqualifyingFlag[] = [],
): { score: number; tier: FitTier; explanation: string[] } {
  const explanation: string[] = [];
  const score = Math.round(
    (Object.keys(weights) as Array<keyof FitScoreComponents>).reduce((total, key) => {
      assertScore(components[key], key);
      const contribution = (components[key] * weights[key]) / 100;
      explanation.push(`${key}: ${contribution.toFixed(1)}/${weights[key]}`);
      return total + contribution;
    }, 0),
  );

  if (flags.length > 0) {
    return {
      score,
      tier: "DISQUALIFIED",
      explanation: [...explanation, `Override: ${flags.join(", ")}`],
    };
  }

  const tier: FitTier =
    score >= 85 ? "PRIORITY" : score >= 70 ? "QUALIFIED" : score >= 55 ? "NURTURE" : "LOW_FIT";
  return { score, tier, explanation };
}
