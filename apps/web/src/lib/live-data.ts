import "server-only";
import { z } from "zod";
import { WORK_PRIORITIES } from "@creatoros/domain";
import { getSession } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const creatorRowsSchema = z.array(
  z.object({
    id: z.string().uuid(),
    creator_number: z.string(),
    stage_name: z.string(),
    status: z.string(),
    current_health_score: z.coerce.number().nullable(),
    current_health_status: z.string().nullable(),
    current_content_buffer_days: z.coerce.number().nullable(),
    assigned_creator_success_user_id: z.string().uuid().nullable(),
    assigned_growth_user_id: z.string().uuid().nullable(),
    priority: z.string().nullable(),
  }),
);
const prospectRowsSchema = z.array(
  z.object({
    id: z.string().uuid(),
    stage_name: z.string(),
    niche: z.string().nullable(),
    follower_count_estimate: z.coerce.number().nullable(),
    fit_score: z.coerce.number().nullable(),
    fit_tier: z.string().nullable(),
    pipeline_stage: z.string(),
    assigned_owner: z.string().uuid().nullable(),
    next_followup_at: z.string().nullable(),
    updated_at: z.string(),
  }),
);
const auditRowsSchema = z.array(
  z.object({
    action: z.string(),
    resource_type: z.string(),
    resource_id: z.string().uuid().nullable(),
    actor_type: z.string(),
    actor_service: z.string().nullable(),
    actor_user_id: z.string().uuid().nullable(),
    created_at: z.string(),
    correlation_id: z.string().uuid(),
  }),
);
const userRowsSchema = z.array(
  z.object({
    id: z.string().uuid(),
    display_name: z.string().nullable(),
    email: z.string(),
  }),
);
const revenueRowsSchema = z.array(
  z.object({
    creator_id: z.string().uuid(),
    date: z.string(),
    creator_platform_receipts: z.coerce.number().nullable(),
  }),
);
const connectionRowsSchema = z.array(
  z.object({
    creator_id: z.string().uuid().nullable(),
    provider: z.string(),
    status: z.string(),
    health: z.string().nullable(),
  }),
);

/**
 * Revenue, ownership and integration health are genuinely absent until data is
 * imported or a person is assigned. CreatorOS reports unknown as `null`, never
 * as `0`: a fabricated zero asserts "this creator earned nothing", which is a
 * different and far worse claim than "we have no data for this creator".
 */
export interface LiveCreatorRow {
  id: string;
  creatorNumber: string;
  stageName: string;
  status: string;
  monthlyRevenue: number | null;
  revenueTrendPercent: number | null;
  healthScore: number | null;
  healthBand: string;
  contentBufferDays: number | null;
  owner: string | null;
  integrationHealth: string;
  /** Null means nobody has triaged this creator yet, not that it is low. */
  priority: string | null;
}

export interface LiveProspectRow {
  id: string;
  stageName: string;
  niche: string;
  followerCountEstimate: number | null;
  fitScore: number | null;
  fitTier: string;
  pipelineStage: string;
  owner: string | null;
  nextFollowupAt: string | null;
  updatedAt: string;
}

type AdminClient = NonNullable<ReturnType<typeof createSupabaseAdminClient>>;

async function context() {
  const session = await getSession();
  const client = createSupabaseAdminClient();
  if (!session || !client) throw new Error("LIVE_DATA_UNAVAILABLE");
  return { session, client };
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

async function resolveUserLabels(
  client: AdminClient,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Map();
  const { data, error } = await client
    .from("users")
    .select("id,display_name,email")
    .in("id", unique);
  if (error) throw new Error(`USER_LOOKUP_FAILED: ${error.message}`);
  return new Map(
    userRowsSchema.parse(data ?? []).map((row) => [row.id, row.display_name ?? row.email]),
  );
}

export interface LiveTeamMember {
  id: string;
  name: string;
}

/**
 * The people a creator can be assigned to.
 *
 * Reads the org's active memberships, which is the only place CreatorOS models
 * who works here. Needed because creator assignment had no write surface and
 * therefore no roster to pick from -- an owner could only be set by editing
 * the row in the database directly.
 */
export async function getLiveTeamMembers(): Promise<LiveTeamMember[]> {
  const { session, client } = await context();
  const { data, error } = await client
    .from("organization_memberships")
    .select("user_id")
    .eq("organization_id", session.organizationId)
    .eq("active", true);
  if (error) throw new Error(`TEAM_READ_FAILED: ${error.message}`);
  const rows = z.array(z.object({ user_id: z.string().uuid() })).parse(data ?? []);
  if (rows.length === 0) return [];
  const labels = await resolveUserLabels(
    client,
    rows.map((row) => row.user_id),
  );
  return rows
    .map((row) => ({ id: row.user_id, name: labels.get(row.user_id) ?? "Unknown user" }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Orders the roster the way an operator triages: most urgent first.
 *
 * `creators.priority` had a write surface and a dedicated index
 * (`creators_org_priority_idx`) from the day it was added, and no read path
 * ever selected it -- a founder recorded "this is the creator to worry about
 * this week" and the roster went on listing alphabetically. Untriaged sorts
 * last rather than first: no decision is not the same as low urgency, but it
 * is also not a reason to head the list.
 */
function byOperationalPriority(left: LiveCreatorRow, right: LiveCreatorRow): number {
  const rank = (value: string | null) => {
    const index = (WORK_PRIORITIES as readonly string[]).indexOf(value ?? "");
    return index === -1 ? WORK_PRIORITIES.length : index;
  };
  const difference = rank(left.priority) - rank(right.priority);
  return difference !== 0 ? difference : left.stageName.localeCompare(right.stageName);
}

export async function getLiveCreators(): Promise<LiveCreatorRow[]> {
  const { session, client } = await context();
  const { data, error } = await client
    .from("creators")
    .select(
      "id,creator_number,stage_name,status,current_health_score,current_health_status,current_content_buffer_days,assigned_creator_success_user_id,assigned_growth_user_id,priority",
    )
    .eq("organization_id", session.organizationId)
    .is("archived_at", null)
    .order("stage_name");
  if (error) throw new Error(`CREATORS_READ_FAILED: ${error.message}`);
  const rows = creatorRowsSchema.parse(data ?? []);
  if (rows.length === 0) return [];
  const creatorIds = rows.map((row) => row.id);

  const [revenue, connections, owners] = await Promise.all([
    client
      .from("creator_revenue_daily")
      .select("creator_id,date,creator_platform_receipts")
      .eq("organization_id", session.organizationId)
      .in("creator_id", creatorIds)
      .gte("date", isoDaysAgo(60)),
    client
      .from("integration_connections")
      .select("creator_id,provider,status,health")
      .eq("organization_id", session.organizationId),
    resolveUserLabels(
      client,
      rows.flatMap((row) =>
        [row.assigned_creator_success_user_id, row.assigned_growth_user_id].filter(
          (id): id is string => typeof id === "string",
        ),
      ),
    ),
  ]);
  if (revenue.error) throw new Error(`REVENUE_READ_FAILED: ${revenue.error.message}`);
  if (connections.error) throw new Error(`INTEGRATIONS_READ_FAILED: ${connections.error.message}`);

  const cutoff = isoDaysAgo(30);
  const current = new Map<string, number>();
  const prior = new Map<string, number>();
  const observed = new Set<string>();
  for (const row of revenueRowsSchema.parse(revenue.data ?? [])) {
    observed.add(row.creator_id);
    const bucket = row.date >= cutoff ? current : prior;
    const receipts = row.creator_platform_receipts ?? 0;
    bucket.set(row.creator_id, (bucket.get(row.creator_id) ?? 0) + receipts);
  }

  const connectionRows = connectionRowsSchema.parse(connections.data ?? []);
  const healthFor = (creatorId: string): string => {
    const relevant = connectionRows.filter(
      (row) => row.creator_id === creatorId || row.creator_id === null,
    );
    if (relevant.length === 0) return "NOT_CONFIGURED";
    if (relevant.some((row) => row.status === "ERROR" || row.health === "ERROR")) return "ERROR";
    if (relevant.some((row) => row.status === "DEGRADED" || row.health === "DEGRADED"))
      return "DEGRADED";
    if (relevant.every((row) => row.status === "CONNECTED")) return "CONNECTED";
    return relevant[0]?.status ?? "NOT_CONFIGURED";
  };

  return rows.map((row) => {
    const currentTotal = current.get(row.id) ?? 0;
    const priorTotal = prior.get(row.id) ?? 0;
    const hasRevenue = observed.has(row.id);
    return {
      id: row.id,
      creatorNumber: row.creator_number,
      stageName: row.stage_name,
      status: row.status,
      monthlyRevenue: hasRevenue ? Math.round(currentTotal) : null,
      revenueTrendPercent:
        hasRevenue && priorTotal > 0
          ? Math.round(((currentTotal - priorTotal) / priorTotal) * 100)
          : null,
      healthScore: row.current_health_score,
      healthBand: row.current_health_status ?? "UNKNOWN",
      contentBufferDays: row.current_content_buffer_days,
      owner:
        owners.get(row.assigned_creator_success_user_id ?? "") ??
        owners.get(row.assigned_growth_user_id ?? "") ??
        null,
      integrationHealth: healthFor(row.id),
      priority: row.priority,
    };
  })
  .sort(byOperationalPriority);
}

export async function getLiveProspects(): Promise<LiveProspectRow[]> {
  const { session, client } = await context();
  const { data, error } = await client
    .from("prospects")
    .select(
      "id,stage_name,niche,follower_count_estimate,fit_score,fit_tier,pipeline_stage,assigned_owner,next_followup_at,updated_at",
    )
    .eq("organization_id", session.organizationId)
    .is("archived_at", null)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`PROSPECTS_READ_FAILED: ${error.message}`);
  const rows = prospectRowsSchema.parse(data ?? []);
  const owners = await resolveUserLabels(
    client,
    rows.map((row) => row.assigned_owner).filter((id): id is string => typeof id === "string"),
  );
  return rows.map((row) => ({
    id: row.id,
    stageName: row.stage_name,
    niche: row.niche ?? "Unclassified",
    followerCountEstimate: row.follower_count_estimate,
    fitScore: row.fit_score,
    fitTier: row.fit_tier ?? "UNSCORED",
    pipelineStage: row.pipeline_stage,
    owner: row.assigned_owner ? (owners.get(row.assigned_owner) ?? null) : null,
    nextFollowupAt: row.next_followup_at,
    updatedAt: row.updated_at,
  }));
}

const workflowStepRowSchema = z.object({
  step_key: z.string(),
  status: z.string(),
  ordinal: z.coerce.number(),
  attempts: z.coerce.number(),
  error_message: z.string().nullable(),
  provider: z.string().nullable(),
  external_id: z.string().nullable(),
});
const workflowRunRowsSchema = z.array(
  z.object({
    id: z.string().uuid(),
    run_number: z.string(),
    status: z.string(),
    creator_id: z.string().uuid().nullable(),
    started_at: z.string(),
    completed_at: z.string().nullable(),
    blockers_json: z.array(z.string()),
    workflow_steps: z.array(workflowStepRowSchema),
  }),
);

export interface LiveWorkflowStep {
  name: string;
  status: string;
  attempts: number;
  error: string | null;
  provider: string | null;
  externalId: string | null;
}

export interface LiveWorkflowRun {
  id: string;
  runNumber: string;
  status: string;
  creatorId: string | null;
  creatorName: string;
  startedAt: string;
  completedAt: string | null;
  blockers: string[];
  steps: LiveWorkflowStep[];
  /** Completed steps over total. Derived, never a hardcoded figure. */
  progressPercent: number;
}

export async function getLiveWorkflowRuns(): Promise<LiveWorkflowRun[]> {
  const { session, client } = await context();
  const { data, error } = await client
    .from("workflow_runs")
    .select(
      "id,run_number,status,creator_id,started_at,completed_at,blockers_json,workflow_steps(step_key,status,ordinal,attempts,error_message,provider,external_id)",
    )
    .eq("organization_id", session.organizationId)
    .order("started_at", { ascending: false })
    .limit(25);
  if (error) throw new Error(`WORKFLOW_RUNS_READ_FAILED: ${error.message}`);
  const rows = workflowRunRowsSchema.parse(data ?? []);
  if (rows.length === 0) return [];

  const creatorIds = rows
    .map((row) => row.creator_id)
    .filter((id): id is string => typeof id === "string");
  const names = new Map<string, string>();
  if (creatorIds.length) {
    const creators = await client
      .from("creators")
      .select("id,stage_name")
      .eq("organization_id", session.organizationId)
      .in("id", creatorIds);
    if (creators.error) throw new Error(`CREATOR_LOOKUP_FAILED: ${creators.error.message}`);
    for (const row of z
      .array(z.object({ id: z.string().uuid(), stage_name: z.string() }))
      .parse(creators.data ?? []))
      names.set(row.id, row.stage_name);
  }

  return rows.map((row) => {
    const steps = [...row.workflow_steps].sort((a, b) => a.ordinal - b.ordinal);
    const succeeded = steps.filter((step) => step.status === "SUCCEEDED").length;
    return {
      id: row.id,
      runNumber: row.run_number,
      status: row.status,
      creatorId: row.creator_id,
      creatorName: (row.creator_id && names.get(row.creator_id)) || "Unassigned",
      startedAt: row.started_at,
      completedAt: row.completed_at,
      blockers: row.blockers_json,
      steps: steps.map((step) => ({
        name: step.step_key,
        status: step.status,
        attempts: step.attempts,
        error: step.error_message,
        provider: step.provider,
        externalId: step.external_id,
      })),
      progressPercent: steps.length ? Math.round((succeeded / steps.length) * 100) : 0,
    };
  });
}

export async function getLiveAuditEvents() {
  const { session, client } = await context();
  const { data, error } = await client
    .from("audit_events")
    .select(
      "id,action,resource_type,resource_id,actor_type,actor_service,actor_user_id,created_at,correlation_id",
    )
    .eq("organization_id", session.organizationId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`AUDIT_READ_FAILED: ${error.message}`);
  return auditRowsSchema.parse(data ?? []).map((row) => ({
    action: row.action,
    resource: `${row.resource_type}${row.resource_id ? ` · ${row.resource_id.slice(0, 8)}` : ""}`,
    actor: row.actor_service ?? row.actor_user_id ?? "system",
    type: row.actor_type.toUpperCase(),
    time: new Date(row.created_at).toLocaleString(),
    correlation: row.correlation_id.slice(0, 13),
  }));
}

/* ------------------------------------------------------------------------- *
 * Readers for pages that previously rendered seed fixtures unconditionally.
 *
 * Each returns exactly what the database holds. Where a value is genuinely
 * absent it stays null rather than becoming a zero, because on these pages a
 * zero reads as a measured result.
 * ------------------------------------------------------------------------- */

async function resolveCreatorNames(
  client: AdminClient,
  organizationId: string,
  creatorIds: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(creatorIds)];
  if (unique.length === 0) return new Map();
  const { data, error } = await client
    .from("creators")
    .select("id,stage_name")
    .eq("organization_id", organizationId)
    .in("id", unique);
  if (error) throw new Error(`CREATOR_NAME_LOOKUP_FAILED: ${error.message}`);
  return new Map(
    z
      .array(z.object({ id: z.string().uuid(), stage_name: z.string() }))
      .parse(data ?? [])
      .map((row) => [row.id, row.stage_name]),
  );
}

export interface LivePnlRow {
  creatorId: string;
  creator: string;
  periodStart: string;
  periodEnd: string;
  receipts: number | null;
  commissionRate: number | null;
  foundryRevenue: number | null;
  directCosts: number | null;
  contributionProfit: number | null;
  contributionMargin: number | null;
}

const COST_FIELDS = [
  "fan_ops_labor",
  "creator_success_labor",
  "editing_cost",
  "growth_labor",
  "creator_specific_software",
  "promotion_cost",
  "paid_traffic_cost",
  "contractor_cost",
  "other_direct_cost",
] as const;

export async function getLivePnlRows(): Promise<LivePnlRow[]> {
  const { session, client } = await context();
  const { data, error } = await client
    .from("creator_pnl_periods")
    .select(
      "creator_id,period_start,period_end,creator_platform_receipts,commission_rate,foundry_revenue,fan_ops_labor,creator_success_labor,editing_cost,growth_labor,creator_specific_software,promotion_cost,paid_traffic_cost,contractor_cost,other_direct_cost,contribution_profit,contribution_margin",
    )
    .eq("organization_id", session.organizationId)
    .order("period_start", { ascending: false })
    .limit(50);
  if (error) throw new Error(`PNL_READ_FAILED: ${error.message}`);
  const numeric = z.coerce.number().nullable();
  const rows = z
    .array(
      z.object({
        creator_id: z.string().uuid(),
        period_start: z.string(),
        period_end: z.string(),
        creator_platform_receipts: numeric,
        commission_rate: numeric,
        foundry_revenue: numeric,
        fan_ops_labor: numeric,
        creator_success_labor: numeric,
        editing_cost: numeric,
        growth_labor: numeric,
        creator_specific_software: numeric,
        promotion_cost: numeric,
        paid_traffic_cost: numeric,
        contractor_cost: numeric,
        other_direct_cost: numeric,
        contribution_profit: numeric,
        contribution_margin: numeric,
      }),
    )
    .parse(data ?? []);
  if (rows.length === 0) return [];
  const names = await resolveCreatorNames(
    client,
    session.organizationId,
    rows.map((row) => row.creator_id),
  );
  return rows.map((row) => {
    // Only sum costs that were actually recorded. If every component is null the
    // total is unknown, not zero: a zero cost line reads as a measured result.
    const recorded = COST_FIELDS.map((field) => row[field]).filter(
      (value): value is number => value !== null,
    );
    return {
      creatorId: row.creator_id,
      creator: names.get(row.creator_id) ?? "Unknown creator",
      periodStart: row.period_start,
      periodEnd: row.period_end,
      receipts: row.creator_platform_receipts,
      // Stored as fractions (0.3, matching calculateCreatorPnl's input/output
      // convention in packages/domain/src/pnl.ts) but LivePnlRow -- and the
      // economics page that renders it with a bare "%" and feeds it into
      // marginBand()'s 50/35 thresholds -- means 0-100. Left unconverted, a
      // real margin (always < 1) always read as CRITICAL.
      commissionRate: toPercent(row.commission_rate),
      foundryRevenue: row.foundry_revenue,
      directCosts: recorded.length ? recorded.reduce((sum, value) => sum + value, 0) : null,
      contributionProfit: row.contribution_profit,
      contributionMargin: toPercent(row.contribution_margin),
    };
  });
}

function toPercent(fraction: number | null): number | null {
  return fraction === null ? null : Math.round(fraction * 1000) / 10;
}

export interface LiveTaskRow {
  id: string;
  title: string;
  creatorName: string | null;
  department: string | null;
  priority: string | null;
  status: string;
  dueAt: string | null;
  sourceType: string | null;
}

export async function getLiveTasks(): Promise<LiveTaskRow[]> {
  const { session, client } = await context();
  const { data, error } = await client
    .from("tasks")
    .select("id,title,creator_id,department,priority,status,due_at,source_type")
    .eq("organization_id", session.organizationId)
    // Only this page's pulse counts (open/overdue) consume the result, and
    // without this a completed task with an old due_at sorted ahead of a
    // currently open one -- an org with real history could fill the 200-row
    // cap with DONE tasks before the query ever reached the open ones,
    // silently undercounting both figures.
    .neq("status", "DONE")
    .order("due_at", { ascending: true, nullsFirst: false })
    .limit(200);
  if (error) throw new Error(`TASKS_READ_FAILED: ${error.message}`);
  const rows = z
    .array(
      z.object({
        id: z.string().uuid(),
        title: z.string(),
        creator_id: z.string().uuid().nullable(),
        department: z.string().nullable(),
        priority: z.string().nullable(),
        status: z.string(),
        due_at: z.string().nullable(),
        source_type: z.string().nullable(),
      }),
    )
    .parse(data ?? []);
  const names = await resolveCreatorNames(
    client,
    session.organizationId,
    rows.map((row) => row.creator_id).filter((id): id is string => typeof id === "string"),
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    creatorName: row.creator_id ? (names.get(row.creator_id) ?? null) : null,
    department: row.department,
    priority: row.priority,
    status: row.status,
    dueAt: row.due_at,
    sourceType: row.source_type,
  }));
}

export interface LiveReportRow {
  id: string;
  creatorId: string;
  creatorName: string;
  reportDate: string;
  status: string;
  healthStatus: string | null;
  summary: string;
  primaryBottleneck: string | null;
  priority: string | null;
  provider: string;
}

export async function getLiveReports(): Promise<LiveReportRow[]> {
  const { session, client } = await context();
  const { data, error } = await client
    .from("daily_creator_reports")
    .select(
      "id,creator_id,report_date,status,health_status,summary,primary_bottleneck,priority,provider",
    )
    .eq("organization_id", session.organizationId)
    .order("report_date", { ascending: false })
    .limit(60);
  if (error) throw new Error(`REPORTS_READ_FAILED: ${error.message}`);
  const rows = z
    .array(
      z.object({
        id: z.string().uuid(),
        creator_id: z.string().uuid(),
        report_date: z.string(),
        status: z.string(),
        health_status: z.string().nullable(),
        summary: z.string(),
        primary_bottleneck: z.string().nullable(),
        priority: z.string().nullable(),
        provider: z.string(),
      }),
    )
    .parse(data ?? []);
  const names = await resolveCreatorNames(
    client,
    session.organizationId,
    rows.map((row) => row.creator_id),
  );
  return rows.map((row) => ({
    id: row.id,
    creatorId: row.creator_id,
    creatorName: names.get(row.creator_id) ?? "Unknown creator",
    reportDate: row.report_date,
    status: row.status,
    healthStatus: row.health_status,
    summary: row.summary,
    primaryBottleneck: row.primary_bottleneck,
    priority: row.priority,
    provider: row.provider,
  }));
}

export interface LiveIncidentRow {
  id: string;
  incidentNumber: string | null;
  title: string;
  type: string;
  severity: string;
  status: string;
  creatorName: string | null;
  detectedAt: string;
  resolvedAt: string | null;
}

export async function getLiveIncidents(): Promise<LiveIncidentRow[]> {
  const { session, client } = await context();
  const { data, error } = await client
    .from("incidents")
    .select("id,incident_number,title,type,severity,status,creator_id,detected_at,resolved_at")
    .eq("organization_id", session.organizationId)
    .order("detected_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`INCIDENTS_READ_FAILED: ${error.message}`);
  const rows = z
    .array(
      z.object({
        id: z.string().uuid(),
        incident_number: z.string().nullable(),
        title: z.string(),
        type: z.string(),
        severity: z.string(),
        status: z.string(),
        creator_id: z.string().uuid().nullable(),
        detected_at: z.string(),
        resolved_at: z.string().nullable(),
      }),
    )
    .parse(data ?? []);
  const names = await resolveCreatorNames(
    client,
    session.organizationId,
    rows.map((row) => row.creator_id).filter((id): id is string => typeof id === "string"),
  );
  return rows.map((row) => ({
    id: row.id,
    incidentNumber: row.incident_number,
    title: row.title,
    type: row.type,
    severity: row.severity,
    status: row.status,
    creatorName: row.creator_id ? (names.get(row.creator_id) ?? null) : null,
    detectedAt: row.detected_at,
    resolvedAt: row.resolved_at,
  }));
}

export interface LiveExperimentRow {
  id: string;
  name: string;
  creatorName: string;
  status: string;
  hypothesis: string;
  primaryMetric: string;
  result: string | null;
  confidence: string;
  startedAt: string | null;
}

export async function getLiveExperiments(): Promise<LiveExperimentRow[]> {
  const { session, client } = await context();
  const { data, error } = await client
    .from("experiments")
    .select("id,name,creator_id,status,hypothesis,primary_metric,result,confidence,started_at")
    .eq("organization_id", session.organizationId)
    .order("started_at", { ascending: false, nullsFirst: false })
    .limit(100);
  if (error) throw new Error(`EXPERIMENTS_READ_FAILED: ${error.message}`);
  const rows = z
    .array(
      z.object({
        id: z.string().uuid(),
        name: z.string(),
        creator_id: z.string().uuid(),
        status: z.string(),
        hypothesis: z.string(),
        primary_metric: z.string(),
        result: z.string().nullable(),
        confidence: z.string(),
        started_at: z.string().nullable(),
      }),
    )
    .parse(data ?? []);
  const names = await resolveCreatorNames(
    client,
    session.organizationId,
    rows.map((row) => row.creator_id),
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    creatorName: names.get(row.creator_id) ?? "Unknown creator",
    status: row.status,
    hypothesis: row.hypothesis,
    primaryMetric: row.primary_metric,
    result: row.result,
    confidence: row.confidence,
    startedAt: row.started_at,
  }));
}

export interface LiveContentRow {
  id: string;
  title: string | null;
  creatorName: string;
  assetType: string | null;
  platform: string | null;
  approvalStatus: string | null;
  inventoryCategory: string | null;
  usedCount: number;
}

export async function getLiveContentAssets(): Promise<LiveContentRow[]> {
  const { session, client } = await context();
  const { data, error } = await client
    .from("content_assets")
    .select("id,title,creator_id,asset_type,platform,approval_status,inventory_category,used_count")
    .eq("organization_id", session.organizationId)
    .limit(200);
  if (error) throw new Error(`CONTENT_READ_FAILED: ${error.message}`);
  const rows = z
    .array(
      z.object({
        id: z.string().uuid(),
        title: z.string().nullable(),
        creator_id: z.string().uuid(),
        asset_type: z.string().nullable(),
        platform: z.string().nullable(),
        approval_status: z.string().nullable(),
        inventory_category: z.string().nullable(),
        used_count: z.coerce.number(),
      }),
    )
    .parse(data ?? []);
  const names = await resolveCreatorNames(
    client,
    session.organizationId,
    rows.map((row) => row.creator_id),
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    creatorName: names.get(row.creator_id) ?? "Unknown creator",
    assetType: row.asset_type,
    platform: row.platform,
    approvalStatus: row.approval_status,
    inventoryCategory: row.inventory_category,
    usedCount: row.used_count,
  }));
}

export interface LiveApplicationRow {
  id: string;
  stageName: string;
  preferredName: string;
  email: string;
  status: string | null;
  submittedAt: string | null;
}

export async function getLiveApplications(): Promise<LiveApplicationRow[]> {
  const { session, client } = await context();
  const { data, error } = await client
    .from("creator_applications")
    .select("id,stage_name,preferred_name,email,review_status,created_at")
    .eq("organization_id", session.organizationId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`APPLICATIONS_READ_FAILED: ${error.message}`);
  return z
    .array(
      z.object({
        id: z.string().uuid(),
        stage_name: z.string(),
        preferred_name: z.string(),
        email: z.string(),
        review_status: z.string().nullable(),
        created_at: z.string(),
      }),
    )
    .parse(data ?? [])
    .map((row) => ({
      id: row.id,
      stageName: row.stage_name,
      preferredName: row.preferred_name,
      email: row.email,
      status: row.review_status,
      submittedAt: row.created_at,
    }));
}

export interface LiveCreatorDetail {
  creator: LiveCreatorRow & {
    contractStatus: string | null;
    jurisdictionStatus: string | null;
    adultConfirmationStatus: string | null;
    startDate: string | null;
    timezone: string | null;
    primaryPlatform: string | null;
    /**
     * Exposed per seat so the activation-gates controls can show who currently
     * holds each one. The collapsed `owner` label on LiveCreatorRow picks a
     * single winner and cannot round-trip into two independent controls.
     */
    assignedCreatorSuccessUserId: string | null;
    assignedGrowthUserId: string | null;
    /** Null means nobody has triaged this creator yet, not that it is low. */
    priority: string | null;
    /** The optimistic-concurrency token the priority control sends back. */
    updatedAt: string;
  };
  latestReport: LiveReportRow | null;
  tasks: LiveTaskRow[];
  /** Null when no Brand Dossier row exists — not an empty dossier. */
  brandProfile: {
    knownFor: string | null;
    positioning: string | null;
    niche: string | null;
  } | null;
  // Shaped from creator_boundaries' own columns. This used to claim
  // creator_truth_items' shape (category/statement/item_type) while querying
  // creator_boundaries, so PostgREST answered 42703 "column does not exist"
  // on every live creator.
  boundaries: Array<{ boundaryType: string; description: string; severity: string }>;
  baselineFrozen: boolean;
}

/**
 * Everything Creator 360 needs, read from the database.
 *
 * Absent records return null rather than an empty object, so the page can say
 * "not recorded" instead of implying a dossier exists but is blank.
 */
export async function getLiveCreatorDetail(creatorId: string): Promise<LiveCreatorDetail | null> {
  const { session, client } = await context();
  const creatorResult = await client
    .from("creators")
    .select(
      "id,creator_number,stage_name,status,current_health_score,current_health_status,current_content_buffer_days,assigned_creator_success_user_id,assigned_growth_user_id,contract_status,jurisdiction_review_status,adult_confirmation_status,start_date,timezone,primary_platform,priority,updated_at",
    )
    .eq("organization_id", session.organizationId)
    .eq("id", creatorId)
    .maybeSingle();
  if (creatorResult.error) throw new Error(`CREATOR_READ_FAILED: ${creatorResult.error.message}`);
  const parsed = z
    .object({
      id: z.string().uuid(),
      creator_number: z.string(),
      stage_name: z.string(),
      status: z.string(),
      current_health_score: z.coerce.number().nullable(),
      current_health_status: z.string().nullable(),
      current_content_buffer_days: z.coerce.number().nullable(),
      assigned_creator_success_user_id: z.string().uuid().nullable(),
      assigned_growth_user_id: z.string().uuid().nullable(),
      contract_status: z.string().nullable(),
      jurisdiction_review_status: z.string().nullable(),
      adult_confirmation_status: z.string().nullable(),
      start_date: z.string().nullable(),
      timezone: z.string().nullable(),
      primary_platform: z.string().nullable(),
      priority: z.string().nullable(),
      updated_at: z.string(),
    })
    .safeParse(creatorResult.data);
  // A creator in another organization resolves to nothing, exactly like one that
  // does not exist.
  if (!parsed.success) return null;
  const row = parsed.data;

  const [
    revenue,
    connections,
    owners,
    reportResult,
    taskResult,
    brandResult,
    boundaryResult,
    baselineResult,
  ] = await Promise.all([
    client
      .from("creator_revenue_daily")
      .select("creator_id,date,creator_platform_receipts")
      .eq("organization_id", session.organizationId)
      .eq("creator_id", creatorId)
      .gte("date", isoDaysAgo(60)),
    client
      .from("integration_connections")
      .select("creator_id,provider,status,health")
      .eq("organization_id", session.organizationId),
    resolveUserLabels(
      client,
      [row.assigned_creator_success_user_id, row.assigned_growth_user_id].filter(
        (id): id is string => typeof id === "string",
      ),
    ),
    client
      .from("daily_creator_reports")
      .select(
        "id,creator_id,report_date,status,health_status,summary,primary_bottleneck,priority,provider",
      )
      .eq("organization_id", session.organizationId)
      .eq("creator_id", creatorId)
      .order("report_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
    client
      .from("tasks")
      .select("id,title,creator_id,department,priority,status,due_at,source_type")
      .eq("organization_id", session.organizationId)
      .eq("creator_id", creatorId)
      .order("due_at", { ascending: true, nullsFirst: false })
      .limit(50),
    client
      .from("creator_brand_profiles")
      .select("known_for,positioning_statement,niche")
      .eq("organization_id", session.organizationId)
      .eq("creator_id", creatorId)
      .maybeSingle(),
    client
      .from("creator_boundaries")
      .select("boundary_type,description,severity")
      .eq("organization_id", session.organizationId)
      .eq("creator_id", creatorId)
      .eq("active", true)
      .limit(25),
    client
      .from("creator_baselines")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", session.organizationId)
      .eq("creator_id", creatorId),
  ]);
  // Every parallel query checked, not just two of eight. An unchecked error
  // here does not throw -- Supabase returns data: null on failure, which the
  // code below reads exactly like "no rows found" (empty integrations, no
  // latest report, no brand profile, no boundaries, zero baselines). A
  // transient failure on any of these used to render as a clean, empty
  // creator record instead of the read failure it actually was.
  if (revenue.error) throw new Error(`REVENUE_READ_FAILED: ${revenue.error.message}`);
  if (connections.error) throw new Error(`INTEGRATIONS_READ_FAILED: ${connections.error.message}`);
  if (taskResult.error) throw new Error(`TASKS_READ_FAILED: ${taskResult.error.message}`);
  if (reportResult.error) throw new Error(`REPORT_READ_FAILED: ${reportResult.error.message}`);
  if (brandResult.error) throw new Error(`BRAND_PROFILE_READ_FAILED: ${brandResult.error.message}`);
  if (boundaryResult.error)
    throw new Error(`BOUNDARIES_READ_FAILED: ${boundaryResult.error.message}`);
  if (baselineResult.error)
    throw new Error(`BASELINE_READ_FAILED: ${baselineResult.error.message}`);

  const cutoff = isoDaysAgo(30);
  let current = 0;
  let prior = 0;
  let observed = false;
  for (const entry of revenueRowsSchema.parse(revenue.data ?? [])) {
    observed = true;
    if (entry.date >= cutoff) current += entry.creator_platform_receipts ?? 0;
    else prior += entry.creator_platform_receipts ?? 0;
  }

  const connectionRows = connectionRowsSchema.parse(connections.data ?? []);
  const relevant = connectionRows.filter(
    (entry) => entry.creator_id === creatorId || entry.creator_id === null,
  );
  const integrationHealth =
    relevant.length === 0
      ? "NOT_CONFIGURED"
      : relevant.some((entry) => entry.status === "ERROR")
        ? "ERROR"
        : relevant.some((entry) => entry.status === "DEGRADED")
          ? "DEGRADED"
          : relevant.every((entry) => entry.status === "CONNECTED")
            ? "CONNECTED"
            : (relevant[0]?.status ?? "NOT_CONFIGURED");

  const report = z
    .object({
      id: z.string().uuid(),
      creator_id: z.string().uuid(),
      report_date: z.string(),
      status: z.string(),
      health_status: z.string().nullable(),
      summary: z.string(),
      primary_bottleneck: z.string().nullable(),
      priority: z.string().nullable(),
      provider: z.string(),
    })
    .safeParse(reportResult.data);

  const brand = z
    .object({
      known_for: z.string().nullable(),
      positioning_statement: z.string().nullable(),
      niche: z.string().nullable(),
    })
    .safeParse(brandResult.data);

  return {
    creator: {
      id: row.id,
      creatorNumber: row.creator_number,
      stageName: row.stage_name,
      status: row.status,
      monthlyRevenue: observed ? Math.round(current) : null,
      revenueTrendPercent:
        observed && prior > 0 ? Math.round(((current - prior) / prior) * 100) : null,
      healthScore: row.current_health_score,
      healthBand: row.current_health_status ?? "UNKNOWN",
      contentBufferDays: row.current_content_buffer_days,
      owner:
        owners.get(row.assigned_creator_success_user_id ?? "") ??
        owners.get(row.assigned_growth_user_id ?? "") ??
        null,
      integrationHealth,
      contractStatus: row.contract_status,
      jurisdictionStatus: row.jurisdiction_review_status,
      adultConfirmationStatus: row.adult_confirmation_status,
      startDate: row.start_date,
      timezone: row.timezone,
      primaryPlatform: row.primary_platform,
      assignedCreatorSuccessUserId: row.assigned_creator_success_user_id,
      assignedGrowthUserId: row.assigned_growth_user_id,
      priority: row.priority,
      updatedAt: row.updated_at,
    },
    latestReport: report.success
      ? {
          id: report.data.id,
          creatorId: report.data.creator_id,
          creatorName: row.stage_name,
          reportDate: report.data.report_date,
          status: report.data.status,
          healthStatus: report.data.health_status,
          summary: report.data.summary,
          primaryBottleneck: report.data.primary_bottleneck,
          priority: report.data.priority,
          provider: report.data.provider,
        }
      : null,
    tasks: z
      .array(
        z.object({
          id: z.string().uuid(),
          title: z.string(),
          creator_id: z.string().uuid().nullable(),
          department: z.string().nullable(),
          priority: z.string().nullable(),
          status: z.string(),
          due_at: z.string().nullable(),
          source_type: z.string().nullable(),
        }),
      )
      .parse(taskResult.data ?? [])
      .map((task) => ({
        id: task.id,
        title: task.title,
        creatorName: row.stage_name,
        department: task.department,
        priority: task.priority,
        status: task.status,
        dueAt: task.due_at,
        sourceType: task.source_type,
      })),
    brandProfile: brand.success
      ? {
          knownFor: brand.data.known_for,
          positioning: brand.data.positioning_statement,
          niche: brand.data.niche,
        }
      : null,
    boundaries: z
      .array(
        z.object({
          boundary_type: z.string(),
          description: z.string(),
          severity: z.string(),
        }),
      )
      .parse(boundaryResult.data ?? [])
      .map((entry) => ({
        boundaryType: entry.boundary_type,
        description: entry.description,
        severity: entry.severity,
      })),
    baselineFrozen: (baselineResult.count ?? 0) > 0,
  };
}
