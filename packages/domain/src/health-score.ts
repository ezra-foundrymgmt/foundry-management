import type { HealthBand, HealthComponents } from "./types";

export const DEFAULT_HEALTH_WEIGHTS: Record<keyof HealthComponents, number> = {
  financial: 20,
  organicAcquisition: 15,
  creatorExecution: 15,
  fanMonetization: 15,
  fanRetention: 10,
  contentInventory: 10,
  creatorRelationship: 10,
  complianceSecurity: 5,
};

export function healthBand(score: number): HealthBand {
  return score >= 80 ? "GREEN" : score >= 65 ? "WATCH" : score >= 50 ? "AT_RISK" : "CRITICAL";
}

export function calculateHealthScore(
  components: HealthComponents,
  criticalIncident = false,
  weights = DEFAULT_HEALTH_WEIGHTS,
): { score: number; band: HealthBand; breakdown: Record<string, number>; overridden: boolean } {
  const weightTotal = Object.values(weights).reduce((sum, value) => sum + value, 0);
  if (weightTotal !== 100)
    throw new Error(`Health weights must total 100, received ${weightTotal}`);

  const breakdown: Record<string, number> = {};
  const score = Math.round(
    (Object.keys(weights) as Array<keyof HealthComponents>).reduce((sum, key) => {
      const value = components[key];
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        throw new RangeError(`${key} must be between 0 and 100`);
      }
      const contribution = (value * weights[key]) / 100;
      breakdown[key] = contribution;
      return sum + contribution;
    }, 0),
  );

  return {
    score,
    band: criticalIncident ? "CRITICAL" : healthBand(score),
    breakdown,
    overridden: criticalIncident,
  };
}
