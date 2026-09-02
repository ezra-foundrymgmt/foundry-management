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

async function context() {
  const session = await getSession();
  const client = createSupabaseAdminClient();
  if (!session || !client) throw new Error("LIVE_DATA_UNAVAILABLE");
  return { session, client };
}

export async function getLiveCreators() {
  const { session, client } = await context();
  const { data, error } = await client
    .from("creators")
    .select(
      "id,creator_number,stage_name,status,current_health_score,current_health_status,current_content_buffer_days",
    )
    .eq("organization_id", session.organizationId)
    .is("archived_at", null)
    .order("stage_name");
  if (error) throw new Error(`CREATORS_READ_FAILED: ${error.message}`);
  return creatorRowsSchema.parse(data ?? []).map((row) => ({
    id: row.id,
    creatorNumber: row.creator_number,
    stageName: row.stage_name,
    status: row.status,
    monthlyRevenue: 0,
    revenueTrendPercent: 0,
    healthScore: Number(row.current_health_score ?? 0),
    healthBand: row.current_health_status ?? "UNKNOWN",
    contentBufferDays: Number(row.current_content_buffer_days ?? 0),
    owner: "Assigned team",
    integrationHealth: "CONFIGURED",
  }));
}

export async function getLiveProspects() {
  const { session, client } = await context();
  const { data, error } = await client
    .from("prospects")
    .select("id,stage_name,niche,follower_count_estimate,fit_score,fit_tier,pipeline_stage")
    .eq("organization_id", session.organizationId)
    .is("archived_at", null)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`PROSPECTS_READ_FAILED: ${error.message}`);
  return prospectRowsSchema.parse(data ?? []).map((row) => ({
    id: row.id,
    stageName: row.stage_name,
    niche: row.niche ?? "Unclassified",
    followerCountEstimate: Number(row.follower_count_estimate ?? 0),
    fitScore: Number(row.fit_score ?? 0),
    fitTier: row.fit_tier ?? "UNSCORED",
    pipelineStage: row.pipeline_stage,
    owner: "Assigned owner",
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
