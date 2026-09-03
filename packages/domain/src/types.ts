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

/**
 * Where a measured figure came from, mirroring the `public.data_confidence`
 * Postgres enum. Every metric written into CreatorOS carries one: a figure an
 * operator typed from a platform dashboard is not the same claim as one a
 * provider reported, and that difference has to survive into the report that
 * cites it.
 *
 * A const list rather than a bare union so write surfaces can validate against
 * it with `z.enum` — the same reason WORK_PRIORITIES and HEALTH_BANDS are
 * lists rather than unions.
 */
export const DATA_CONFIDENCES = [
  "MEASURED",
  "PARTIALLY_MEASURED",
  "ESTIMATED",
  "UNKNOWN",
] as const;
export type DataConfidence = (typeof DATA_CONFIDENCES)[number];

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

/**
 * The canonical priority ladder for work items — report recommendations, tasks,
 * and a creator's own operational priority. One list so the write surfaces, the
 * rules engine and the UI cannot drift apart.
 */
export const WORK_PRIORITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
export type WorkPriority = (typeof WORK_PRIORITIES)[number];

/**
 * The canonical department ladder for work items — report recommendations and
 * tasks. Same reasoning as WORK_PRIORITIES: one list so the rules engine, the
 * task write surfaces and the create-task UI cannot drift apart.
 */
export const WORK_DEPARTMENTS = [
  "Growth",
  "Creative",
  "Creator Success",
  "Revenue",
  "Operations",
  "Security",
  "Compliance",
] as const;
export type WorkDepartment = (typeof WORK_DEPARTMENTS)[number];

/**
 * The two human-authority decisions activation blocks on.
 *
 * `convert_prospect_to_creator` inserts a creator at PENDING/NOT_STARTED, and
 * activation readiness demands APPROVED/CONFIRMED — so until these had a write
 * surface, no converted creator could ever be activated. The accepted-value
 * lists in activation-readiness.ts are deliberately wider than these (they also
 * accept COMPLETE/PASSED/VERIFIED from records created before this vocabulary
 * existed); these are what CreatorOS itself writes.
 */
export const JURISDICTION_REVIEW_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type JurisdictionReviewStatus = (typeof JURISDICTION_REVIEW_STATUSES)[number];

export const ADULT_CONFIRMATION_STATUSES = ["NOT_STARTED", "CONFIRMED", "REJECTED"] as const;
export type AdultConfirmationStatus = (typeof ADULT_CONFIRMATION_STATUSES)[number];

/**
 * Creator boundaries — what a creator will and will not do.
 *
 * HARD is never, under any circumstance. SOFT is case-by-case and is the only
 * severity for which `requiresCreatorApproval` is meaningful: a hard limit is
 * not something the creator gets asked about again.
 */
export const BOUNDARY_SEVERITIES = ["HARD", "SOFT"] as const;
export type BoundarySeverity = (typeof BOUNDARY_SEVERITIES)[number];

export const BOUNDARY_TYPES = [
  "CONTENT",
  "PLATFORM",
  "INTERACTION",
  "SCHEDULING",
  "COLLABORATION",
] as const;
export type BoundaryType = (typeof BOUNDARY_TYPES)[number];

export interface Recommendation {
  id: string;
  department: WorkDepartment;
  action: string;
  evidence: string;
  priority: WorkPriority;
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
