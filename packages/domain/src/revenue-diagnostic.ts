import { safeRate } from "./performance";
import type { DailyReport, DataConfidence, MetricPoint, Recommendation } from "./types";

export interface DiagnosticInput {
  creatorId: string;
  reportDate: string;
  current: MetricPoint;
  baseline: MetricPoint;
  healthBand: DailyReport["healthBand"];
  /** null when the buffer has never been measured. Not the same as zero days. */
  contentBufferDays: number | null;
  /**
   * How good the measurements behind `current` actually are — the WEAKEST
   * confidence among the rows that fed it, since a sum is only as trustworthy
   * as its worst input.
   *
   * Required rather than defaulted. Every metric-derived recommendation below
   * was stamped `confidence: "MEASURED"` unconditionally, so a figure an
   * operator entered as ESTIMATED produced a recommendation asserting it had
   * been measured — and a recommendation becomes a real assigned task in one
   * click. The import path has demanded a data_confidence on every row since it
   * was written; the diagnostic threw it away.
   */
  dataConfidence: DataConfidence;
}

function percentChange(current: number, baseline: number): number | null {
  if (baseline <= 0) return null;
  return ((current - baseline) / baseline) * 100;
}

export function generateDailyReport(input: DiagnosticInput): DailyReport {
  const reachChange = percentChange(input.current.reach, input.baseline.reach);
  const acquisitionChange = percentChange(
    input.current.newSubscribers,
    input.baseline.newSubscribers,
  );
  const revenueChange = percentChange(input.current.revenue, input.baseline.revenue);
  const currentFirstPurchase = safeRate(input.current.firstBuyers, input.current.newSubscribers);
  const baselineFirstPurchase = safeRate(input.baseline.firstBuyers, input.baseline.newSubscribers);
  const firstPurchaseChange =
    currentFirstPurchase === null || baselineFirstPurchase === null
      ? null
      : percentChange(currentFirstPurchase, baselineFirstPurchase);

  const anomalies: DailyReport["anomalies"] = [];
  const recommendations: Recommendation[] = [];
  let primaryBottleneck = "No material bottleneck detected";
  let ruleId = "DIAG-STABLE-001";

  if (
    input.current.newSubscribers >= 20 &&
    acquisitionChange !== null &&
    acquisitionChange >= 5 &&
    firstPurchaseChange !== null &&
    firstPurchaseChange <= -10
  ) {
    primaryBottleneck = "First-purchase monetization";
    ruleId = "DIAG-MONETIZATION-FIRST-PURCHASE-001";
    anomalies.push({
      severity: "WARNING",
      message: `First-purchase rate is ${Math.abs(firstPurchaseChange).toFixed(0)}% below baseline while acquisition is healthy.`,
    });
    recommendations.push({
      id: `${input.creatorId}-rec-revenue`,
      department: "Revenue",
      action: "Review the first-purchase offer and onboarding sequence.",
      evidence: "Subscriber acquisition increased while first-purchase conversion deteriorated.",
      priority: "HIGH",
      suggestedOwner: "Revenue Lead",
      dueInDays: 1,
      confidence: input.dataConfidence,
      sourceRule: ruleId,
    });
  } else if (reachChange !== null && reachChange <= -20 && input.current.reach >= 1000) {
    primaryBottleneck = "Organic acquisition / content reach";
    ruleId = "DIAG-ACQUISITION-REACH-001";
    anomalies.push({
      severity: "WARNING",
      message: `Reach is ${Math.abs(reachChange).toFixed(0)}% below baseline.`,
    });
    recommendations.push({
      id: `${input.creatorId}-rec-growth`,
      department: "Growth",
      action: "Review recent format mix and replicate the strongest creator-relative franchise.",
      evidence: "Reach fell materially below the 28-day creator baseline.",
      priority: "HIGH",
      suggestedOwner: "Growth Lead",
      dueInDays: 1,
      confidence: input.dataConfidence,
      sourceRule: ruleId,
    });
  }

  // An unmeasured buffer produces no anomaly. Reporting "critical at 0 days" for
  // a creator nobody has measured invents the alarm and, because the operator can
  // turn a recommendation into a real task, converts it into assigned work.
  if (input.contentBufferDays !== null && input.contentBufferDays < 7) {
    anomalies.push({
      severity: "CRITICAL",
      message: `Content buffer is critical at ${input.contentBufferDays} days.`,
    });
    recommendations.push({
      id: `${input.creatorId}-rec-buffer`,
      department: "Creator Success",
      action: "Schedule a content replenishment sprint with the creator.",
      evidence: `The social content buffer is below the 7-day critical threshold.`,
      priority: "CRITICAL",
      suggestedOwner: "Creator Success",
      dueInDays: 1,
      // Deliberately not input.dataConfidence: this rule reads
      // creators.current_content_buffer_days, which carries no import
      // provenance at all, so neither the metrics confidence nor "MEASURED"
      // honestly describes it.
      confidence: "UNKNOWN",
      sourceRule: "OPS-CONTENT-BUFFER-CRITICAL-001",
    });
  }

  if (reachChange !== null && reachChange >= 20 && input.current.reach >= 1000) {
    anomalies.push({
      severity: "OPPORTUNITY",
      message: `Reach is ${reachChange.toFixed(0)}% above baseline.`,
    });
  }

  return {
    id: `report-${input.creatorId}-${input.reportDate}`,
    creatorId: input.creatorId,
    reportDate: input.reportDate,
    status: "READY",
    healthBand: input.healthBand,
    summary:
      primaryBottleneck === "First-purchase monetization"
        ? "Acquisition remains healthy, but first-purchase conversion needs attention."
        : primaryBottleneck === "Organic acquisition / content reach"
          ? "Reach deterioration is constraining new audience acquisition."
          : "Performance is within expected creator-relative ranges.",
    primaryBottleneck,
    // Only a CRITICAL or WARNING anomaly makes the report urgent. An
    // OPPORTUNITY is good news -- a creator whose only anomaly was reach
    // running 20%+ above baseline used to get flagged HIGH, the same
    // priority as an actual problem, because this only checked whether any
    // anomaly existed rather than what kind.
    priority: anomalies.some((item) => item.severity === "CRITICAL")
      ? "CRITICAL"
      : anomalies.some((item) => item.severity === "WARNING")
        ? "HIGH"
        : "NORMAL",
    metrics: input.current,
    comparisons: {
      reach: reachChange,
      acquisition: acquisitionChange,
      revenue: revenueChange,
      firstPurchase: firstPurchaseChange,
    },
    anomalies,
    recommendations: recommendations.slice(0, 5),
    ruleId,
    provider: "RULES",
  };
}
