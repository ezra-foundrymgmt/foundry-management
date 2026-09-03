import "server-only";
import { z } from "zod";
import { hasPermission, type Permission } from "@creatoros/domain";
import type { AppSession } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type ToolRisk = "READ" | "LOW_RISK_WRITE" | "WORKFLOW";

export interface AgentToolContext {
  session: AppSession;
  correlationId: string;
  /**
   * True when the agent was addressed from a channel that a creator can read.
   * Internal-only tools refuse to run there even for a super_admin, because the
   * risk is disclosure to the creator, not the operator's own authority.
   */
  creatorFacingSurface: boolean;
}

export interface AgentTool {
  name: string;
  description: string;
  permission: Permission;
  risk: ToolRisk;
  /** Tools whose output must never reach a creator-readable Slack channel. */
  internalOnly: boolean;
  inputSchema: z.ZodType;
  parameters: Record<string, unknown>;
  execute(context: AgentToolContext, input: never): Promise<unknown>;
}

export type ToolDenial =
  | { ok: false; error: "UNKNOWN_TOOL" }
  | { ok: false; error: "PERMISSION_DENIED"; permission: Permission }
  | { ok: false; error: "INTERNAL_ONLY_IN_CREATOR_CHANNEL" }
  | { ok: false; error: "INVALID_INPUT"; issues: unknown };

export type ToolResult = { ok: true; data: unknown } | ToolDenial;

function admin() {
  const client = createSupabaseAdminClient();
  if (!client) throw new Error("DATABASE_NOT_CONFIGURED");
  return client;
}

/** Every read is scoped to the caller's organization. There is no unscoped path. */
async function findCreator(context: AgentToolContext, query: string) {
  const client = admin();
  const { data, error } = await client
    .from("creators")
    .select("id,creator_number,stage_name,status,current_health_score,current_health_status")
    .eq("organization_id", context.session.organizationId)
    .is("archived_at", null)
    .or(`stage_name.ilike.%${query}%,creator_number.ilike.%${query}%`)
    .limit(5);
  if (error) throw new Error(`CREATOR_SEARCH_FAILED: ${error.message}`);
  return data ?? [];
}

async function requireCreator(context: AgentToolContext, creatorId: string) {
  const client = admin();
  const { data, error } = await client
    .from("creators")
    .select("id,stage_name,creator_number,status")
    .eq("organization_id", context.session.organizationId)
    .eq("id", creatorId)
    .maybeSingle();
  if (error) throw new Error(`CREATOR_LOOKUP_FAILED: ${error.message}`);
  // Cross-tenant ids resolve to nothing, so the agent cannot confirm that a
  // creator exists in another organization.
  if (!data) throw new Error("CREATOR_NOT_FOUND");
  return data as { id: string; stage_name: string; creator_number: string; status: string };
}

const creatorRef = z.object({ creatorId: z.string().uuid() });

export const AGENT_TOOLS: readonly AgentTool[] = [
  {
    name: "search_creator",
    description:
      "Find creators in this Foundry organization by stage name or creator number. Use this first to resolve a name to a creator id.",
    permission: "creator.read",
    risk: "READ",
    internalOnly: false,
    inputSchema: z.object({ query: z.string().min(1).max(100) }),
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Name or creator number fragment" } },
      required: ["query"],
    },
    async execute(context, input: { query: string }) {
      return { creators: await findCreator(context, input.query) };
    },
  },
  {
    name: "get_creator_summary",
    description:
      "Operating summary for one creator: status, health band and score, content buffer, and assignment.",
    permission: "creator.read",
    risk: "READ",
    internalOnly: false,
    inputSchema: creatorRef,
    parameters: {
      type: "object",
      properties: { creatorId: { type: "string", description: "Creator UUID" } },
      required: ["creatorId"],
    },
    async execute(context, input: { creatorId: string }) {
      await requireCreator(context, input.creatorId);
      const { data, error } = await admin()
        .from("creators")
        .select(
          "id,creator_number,stage_name,status,current_health_score,current_health_status,current_content_buffer_days,contract_status,jurisdiction_review_status,start_date,timezone",
        )
        .eq("organization_id", context.session.organizationId)
        .eq("id", input.creatorId)
        .maybeSingle();
      if (error) throw new Error(`CREATOR_SUMMARY_FAILED: ${error.message}`);
      return data;
    },
  },
  {
    name: "get_creator_metrics",
    description:
      "Recent daily revenue and subscriber counts for one creator. Returns an empty series when no data has been imported; absence of data is not zero revenue.",
    permission: "analytics.read",
    risk: "READ",
    internalOnly: false,
    inputSchema: creatorRef.extend({ days: z.number().int().min(1).max(90).default(30) }),
    parameters: {
      type: "object",
      properties: {
        creatorId: { type: "string" },
        days: { type: "number", description: "Lookback window, 1-90, default 30" },
      },
      required: ["creatorId"],
    },
    async execute(context, input: { creatorId: string; days: number }) {
      await requireCreator(context, input.creatorId);
      const since = new Date(Date.now() - input.days * 86_400_000).toISOString().slice(0, 10);
      const { data, error } = await admin()
        .from("creator_revenue_daily")
        .select("date,creator_platform_receipts,active_subscribers,new_subscribers,data_confidence")
        .eq("organization_id", context.session.organizationId)
        .eq("creator_id", input.creatorId)
        .gte("date", since)
        .order("date", { ascending: false });
      if (error) throw new Error(`CREATOR_METRICS_FAILED: ${error.message}`);
      const rows = data ?? [];
      return {
        days: input.days,
        rowCount: rows.length,
        dataAvailable: rows.length > 0,
        series: rows,
      };
    },
  },
  {
    name: "get_creator_tasks",
    description: "Open and recently completed Foundry tasks for one creator.",
    permission: "creator.read",
    risk: "READ",
    internalOnly: false,
    inputSchema: creatorRef.extend({ status: z.string().max(40).optional() }),
    parameters: {
      type: "object",
      properties: { creatorId: { type: "string" }, status: { type: "string" } },
      required: ["creatorId"],
    },
    async execute(context, input: { creatorId: string; status?: string }) {
      await requireCreator(context, input.creatorId);
      let query = admin()
        .from("tasks")
        .select("id,title,status,priority,department,due_at,owner_user_id,created_at")
        .eq("organization_id", context.session.organizationId)
        .eq("creator_id", input.creatorId)
        .order("due_at", { ascending: true, nullsFirst: false })
        .limit(50);
      if (input.status) query = query.eq("status", input.status);
      const { data, error } = await query;
      if (error) throw new Error(`CREATOR_TASKS_FAILED: ${error.message}`);
      return { tasks: data ?? [] };
    },
  },
  {
    name: "get_creator_reports",
    description: "Most recent daily reports for one creator, newest first.",
    permission: "analytics.read",
    risk: "READ",
    internalOnly: false,
    inputSchema: creatorRef.extend({ limit: z.number().int().min(1).max(14).default(5) }),
    parameters: {
      type: "object",
      properties: { creatorId: { type: "string" }, limit: { type: "number" } },
      required: ["creatorId"],
    },
    async execute(context, input: { creatorId: string; limit: number }) {
      await requireCreator(context, input.creatorId);
      const { data, error } = await admin()
        .from("daily_creator_reports")
        .select("id,report_date,status,health_status,summary,primary_bottleneck,priority,provider")
        .eq("organization_id", context.session.organizationId)
        .eq("creator_id", input.creatorId)
        .order("report_date", { ascending: false })
        .limit(input.limit);
      if (error) throw new Error(`CREATOR_REPORTS_FAILED: ${error.message}`);
      return { reports: data ?? [] };
    },
  },
  {
    name: "get_creator_experiments",
    description: "Experiments for one creator with hypothesis, status, and recorded result.",
    permission: "analytics.read",
    risk: "READ",
    internalOnly: false,
    inputSchema: creatorRef,
    parameters: {
      type: "object",
      properties: { creatorId: { type: "string" } },
      required: ["creatorId"],
    },
    async execute(context, input: { creatorId: string }) {
      await requireCreator(context, input.creatorId);
      const { data, error } = await admin()
        .from("experiments")
        .select(
          "id,name,status,hypothesis,primary_metric,result,confidence,decision,started_at,ended_at",
        )
        .eq("organization_id", context.session.organizationId)
        .eq("creator_id", input.creatorId)
        .order("started_at", { ascending: false })
        .limit(25);
      if (error) throw new Error(`CREATOR_EXPERIMENTS_FAILED: ${error.message}`);
      return { experiments: data ?? [] };
    },
  },
  {
    name: "get_creator_integrations",
    description: "Integration connection status and health for one creator and the organization.",
    permission: "integration.read",
    risk: "READ",
    internalOnly: true,
    inputSchema: creatorRef,
    parameters: {
      type: "object",
      properties: { creatorId: { type: "string" } },
      required: ["creatorId"],
    },
    async execute(context, input: { creatorId: string }) {
      await requireCreator(context, input.creatorId);
      const { data, error } = await admin()
        .from("integration_connections")
        // Never selects credentials; those live in integration_credentials,
        // which no agent tool touches.
        .select("provider,status,health,needs_reauthorization,last_health_check_at,last_success_at")
        .eq("organization_id", context.session.organizationId);
      if (error) throw new Error(`CREATOR_INTEGRATIONS_FAILED: ${error.message}`);
      return { integrations: data ?? [] };
    },
  },
  {
    name: "get_portfolio_alerts",
    description:
      "Cross-portfolio attention list: open incidents, at-risk creators, and overdue tasks.",
    permission: "creator.read",
    risk: "READ",
    internalOnly: true,
    inputSchema: z.object({}),
    parameters: { type: "object", properties: {} },
    async execute(context) {
      const client = admin();
      const organizationId = context.session.organizationId;
      const [incidents, atRisk, overdue] = await Promise.all([
        client
          .from("incidents")
          .select("id,incident_number,title,severity,status,detected_at,creator_id")
          .eq("organization_id", organizationId)
          .neq("status", "RESOLVED")
          .order("detected_at", { ascending: false })
          .limit(20),
        client
          .from("creators")
          .select("id,stage_name,current_health_status,current_health_score")
          .eq("organization_id", organizationId)
          .is("archived_at", null)
          .in("current_health_status", ["AT_RISK", "WATCH"])
          .limit(20),
        client
          .from("tasks")
          .select("id,title,due_at,status,creator_id")
          .eq("organization_id", organizationId)
          .neq("status", "DONE")
          .lt("due_at", new Date().toISOString())
          .order("due_at", { ascending: true })
          .limit(20),
      ]);
      if (incidents.error || atRisk.error || overdue.error)
        throw new Error("PORTFOLIO_ALERTS_FAILED");
      return {
        openIncidents: incidents.data ?? [],
        creatorsNeedingAttention: atRisk.data ?? [],
        overdueTasks: overdue.data ?? [],
      };
    },
  },
  {
    name: "create_internal_task",
    description:
      "Create an internal Foundry task. Internal only: this never creates a creator-facing deliverable.",
    permission: "task.create",
    risk: "LOW_RISK_WRITE",
    internalOnly: true,
    inputSchema: z.object({
      creatorId: z.string().uuid().optional(),
      title: z.string().min(3).max(200),
      description: z.string().max(2000).optional(),
      department: z.string().max(60).optional(),
      priority: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
      dueAt: z.string().datetime().optional(),
    }),
    parameters: {
      type: "object",
      properties: {
        creatorId: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        department: { type: "string" },
        priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
        dueAt: { type: "string", description: "ISO 8601 timestamp" },
      },
      required: ["title"],
    },
    async execute(
      context,
      input: {
        creatorId?: string;
        title: string;
        description?: string;
        department?: string;
        priority: string;
        dueAt?: string;
      },
    ) {
      if (input.creatorId) await requireCreator(context, input.creatorId);
      // Deterministic key: the same request replayed by a Slack retry updates
      // one row instead of creating a second task.
      const idempotencyKey = `agent:${context.correlationId}:task`;
      const { data, error } = await admin()
        .from("tasks")
        .upsert(
          {
            organization_id: context.session.organizationId,
            creator_id: input.creatorId ?? null,
            title: input.title,
            description: input.description ?? null,
            department: input.department ?? null,
            priority: input.priority,
            status: "OPEN",
            requested_by: context.session.userId,
            source_type: "FOUNDRY_AGENT",
            due_at: input.dueAt ?? null,
            idempotency_key: idempotencyKey,
          },
          { onConflict: "organization_id,idempotency_key" },
        )
        .select("id,title,status,priority,due_at")
        .maybeSingle();
      if (error) throw new Error(`TASK_CREATE_FAILED: ${error.message}`);
      return { task: data, idempotencyKey };
    },
  },
  {
    name: "create_content_request",
    description: "Create a content request for a creator with a concept and objective.",
    permission: "task.create",
    risk: "LOW_RISK_WRITE",
    internalOnly: false,
    inputSchema: z.object({
      creatorId: z.string().uuid(),
      title: z.string().min(3).max(200),
      platform: z.string().max(40).optional(),
      objective: z.string().max(500).optional(),
      concept: z.string().max(2000).optional(),
      priority: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
    }),
    parameters: {
      type: "object",
      properties: {
        creatorId: { type: "string" },
        title: { type: "string" },
        platform: { type: "string" },
        objective: { type: "string" },
        concept: { type: "string" },
        priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
      },
      required: ["creatorId", "title"],
    },
    async execute(
      context,
      input: {
        creatorId: string;
        title: string;
        platform?: string;
        objective?: string;
        concept?: string;
        priority: string;
      },
    ) {
      await requireCreator(context, input.creatorId);
      const { data, error } = await admin()
        .from("content_requests")
        .insert({
          organization_id: context.session.organizationId,
          creator_id: input.creatorId,
          title: input.title,
          platform: input.platform ?? null,
          objective: input.objective ?? null,
          concept: input.concept ?? null,
          priority: input.priority,
          status: "REQUESTED",
          requested_by: context.session.userId,
        })
        .select("id,title,status,priority")
        .maybeSingle();
      if (error) throw new Error(`CONTENT_REQUEST_CREATE_FAILED: ${error.message}`);
      return { contentRequest: data };
    },
  },
  {
    name: "acknowledge_alert",
    description:
      "Acknowledge an open incident so the portfolio alert list reflects that a human has seen it.",
    permission: "task.complete",
    risk: "LOW_RISK_WRITE",
    internalOnly: true,
    inputSchema: z.object({ incidentId: z.string().uuid(), note: z.string().max(500).optional() }),
    parameters: {
      type: "object",
      properties: { incidentId: { type: "string" }, note: { type: "string" } },
      required: ["incidentId"],
    },
    async execute(context, input: { incidentId: string; note?: string }) {
      const { data, error } = await admin()
        .from("incidents")
        .update({ status: "ACKNOWLEDGED", owner: context.session.userId })
        .eq("organization_id", context.session.organizationId)
        .eq("id", input.incidentId)
        .neq("status", "RESOLVED")
        .select("id,incident_number,status")
        .maybeSingle();
      if (error) throw new Error(`INCIDENT_ACK_FAILED: ${error.message}`);
      if (!data) throw new Error("INCIDENT_NOT_FOUND_OR_RESOLVED");
      return { incident: data, note: input.note ?? null };
    },
  },
];

export const AGENT_TOOL_NAMES = AGENT_TOOLS.map((tool) => tool.name);

export function findTool(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((tool) => tool.name === name);
}

/**
 * The single gate every tool call passes through. The model never decides
 * whether a call is allowed: the caller's CreatorOS role does, and the surface
 * the question arrived on does. A model that invents a tool name, forges an
 * organization id, or asks for a creator in another tenant gets a denial, not
 * data.
 */
export async function executeAgentTool(
  context: AgentToolContext,
  name: string,
  rawInput: unknown,
): Promise<ToolResult> {
  const tool = findTool(name);
  if (!tool) return { ok: false, error: "UNKNOWN_TOOL" };
  if (!hasPermission(context.session.role, tool.permission))
    return { ok: false, error: "PERMISSION_DENIED", permission: tool.permission };
  if (tool.internalOnly && context.creatorFacingSurface)
    return { ok: false, error: "INTERNAL_ONLY_IN_CREATOR_CHANNEL" };
  const parsed = tool.inputSchema.safeParse(rawInput ?? {});
  if (!parsed.success) return { ok: false, error: "INVALID_INPUT", issues: parsed.error.flatten() };
  const data = await tool.execute(context, parsed.data as never);
  return { ok: true, data };
}
