export const CREATOR_STATUSES = [
  "ONBOARDING",
  "ACTIVE",
  "WATCH",
  "PAUSED",
  "OFFBOARDING",
  "FORMER",
] as const;
export type CreatorStatus = (typeof CREATOR_STATUSES)[number];

// UNKNOWN is a band, not a missing value. A creator whose health has never been
// calculated is not in crisis, and collapsing the absence into CRITICAL — the
// most alarming band — is how an unmeasured creator ends up at the top of the
// triage list.
export const HEALTH_BANDS = ["GREEN", "WATCH", "AT_RISK", "CRITICAL", "UNKNOWN"] as const;
export type HealthBand = (typeof HEALTH_BANDS)[number];

export type TrendDirection = "up" | "down" | "flat";
export type DataConfidence = "MEASURED" | "PARTIALLY_MEASURED" | "ESTIMATED" | "UNKNOWN";

export interface CreatorSummary {
  id: string;
  creatorNumber: string;
  stageName: string;
  preferredName: string;
  status: CreatorStatus;
  healthScore: number;
  healthBand: HealthBand;
  monthlyRevenue: number;
  revenueTrendPercent: number;
  contentBufferDays: number;
  owner: string;
  integrationHealth: "HEALTHY" | "DEGRADED" | "WAITING";
  primaryBottleneck: string;
  latestReportDate: string;
}

export interface MetricPoint {
  date: string;
  reach: number;
  profileVisits: number;
  outboundClicks: number;
  newSubscribers: number;
  firstBuyers: number;
  revenue: number;
}

export interface ContentPerformance {
  id: string;
  title: string;
  franchise: string;
  primaryMetric: number;
  rollingMedian: number;
  multiplier: number;
  status: "OPPORTUNITY" | "BASELINE" | "WEAK";
}

export interface Recommendation {
  id: string;
  department:
    | "Growth"
    | "Creative"
    | "Creator Success"
    | "Revenue"
    | "Operations"
    | "Security"
    | "Compliance";
  action: string;
  evidence: string;
  priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  suggestedOwner: string;
  dueInDays: number;
  confidence: DataConfidence;
  sourceRule: string;
}

export interface DailyReport {
  id: string;
  creatorId: string;
  reportDate: string;
  status: "READY" | "REVIEWED";
  healthBand: HealthBand;
  summary: string;
  primaryBottleneck: string;
  priority: "CRITICAL" | "HIGH" | "NORMAL";
  metrics: MetricPoint;
  comparisons: Record<string, number | null>;
  anomalies: Array<{ severity: "CRITICAL" | "WARNING" | "OPPORTUNITY"; message: string }>;
  recommendations: Recommendation[];
  ruleId: string;
  provider: "RULES" | "MOCK";
}

export interface Task {
  id: string;
  creatorId: string | null;
  title: string;
  department: Recommendation["department"];
  priority: Recommendation["priority"];
  status: "OPEN" | "IN_PROGRESS" | "BLOCKED" | "REVIEW" | "DONE" | "CANCELLED";
  owner: string;
  dueAt: string;
  sourceType: "MANUAL" | "REPORT" | "WORKFLOW";
  sourceId: string | null;
}

export interface Prospect {
  id: string;
  prospectNumber: string;
  preferredName: string;
  stageName: string;
  niche: string;
  followerCountEstimate: number;
  fitScore: number;
  fitTier: FitTier;
  pipelineStage: PipelineStage;
  owner: string;
  nextFollowupAt: string | null;
}

export const PIPELINE_STAGES = [
  "SOURCED",
  "QUALIFIED",
  "RESEARCHED",
  "CONTACTED",
  "FOLLOW_UP",
  "RESPONDED",
  "AUDIT",
  "DISCOVERY",
  "PROPOSAL",
  "CONTRACT",
  "SIGNED",
  "ACTIVATION",
  "NURTURE",
  "LOST",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];
export type FitTier = "PRIORITY" | "QUALIFIED" | "NURTURE" | "LOW_FIT" | "DISQUALIFIED";

export interface FitScoreComponents {
  reliability: number;
  audienceQuality: number;
  marketFit: number;
  productionCapacity: number;
  monetizationHeadroom: number;
  complianceBrandSafety: number;
  coachability: number;
}

export interface HealthComponents {
  financial: number;
  organicAcquisition: number;
  creatorExecution: number;
  fanMonetization: number;
  fanRetention: number;
  contentInventory: number;
  creatorRelationship: number;
  complianceSecurity: number;
}
