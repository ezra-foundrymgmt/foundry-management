export function median(values: number[]): number | null {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (valid.length === 0) return null;
  const middle = Math.floor(valid.length / 2);
  const middleValue = valid[middle];
  if (middleValue === undefined) return null;
  if (valid.length % 2 === 1) return middleValue;
  const left = valid[middle - 1];
  return left === undefined ? null : (left + middleValue) / 2;
}

export function safeRate(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return numerator / denominator;
}

export function performanceMultiplier(metric: number, rollingMedian: number | null): number | null {
  if (rollingMedian === null || rollingMedian <= 0) return null;
  return metric / rollingMedian;
}

export function classifyPerformance(
  multiplier: number | null,
): "OPPORTUNITY" | "BASELINE" | "WEAK" {
  if (multiplier === null) return "BASELINE";
  if (multiplier >= 1.5) return "OPPORTUNITY";
  if (multiplier < 0.75) return "WEAK";
  return "BASELINE";
}
