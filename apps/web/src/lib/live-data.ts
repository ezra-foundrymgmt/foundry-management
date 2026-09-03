import "server-only";
import { z } from "zod";
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

export async function getLiveCreators(): Promise<LiveCreatorRow[]> {
  const { session, client } = await context();
  const { data, error } = await client
    .from("creators")
    .select(
      "id,creator_number,stage_name,status,current_health_score,current_health_status,current_content_buffer_days,assigned_creator_success_user_id,assigned_growth_user_id",
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
    };
  });
}

export async function getLiveProspects(): Promise<LiveProspectRow[]> {
  const { session, client } = await context();
  const { data, error } = await client
    .from("prospects")
    .select(
      "id,stage_name,niche,follower_count_estimate,fit_score,fit_tier,pipeline_stage,assigned_owner,next_followup_at",
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
  }));
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
