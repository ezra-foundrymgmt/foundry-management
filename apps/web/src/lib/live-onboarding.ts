import "server-only";
import {
  LiveNotionProvider,
  LiveSlackProvider,
  ManualFileStorageProvider,
  type ProvisionedResource,
} from "@creatoros/integrations";
import {
  ACTIVATION_STEPS,
  OnboardingService,
  type OnboardingCreator,
  type OnboardingRepository,
  type WorkflowRun,
} from "@creatoros/workflows";
import { z } from "zod";
import { getIntegrationToken, SupabaseProviderResourceStore } from "@/lib/integration-registry";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { SupabaseActivationRecordPort } from "@/lib/activation-records";

const creatorRowSchema = z.object({
  id: z.string().uuid(),
  creator_number: z.string(),
  stage_name: z.string(),
  status: z.string(),
  contract_status: z.string(),
  adult_confirmation_status: z.string(),
  jurisdiction_review_status: z.string(),
  email: z.string().email().nullable(),
  timezone: z.string().nullable(),
  assigned_creator_success_user_id: z.string().uuid().nullable(),
  assigned_growth_user_id: z.string().uuid().nullable(),
});
const workflowStepRowSchema = z.object({
  step_key: z.enum(ACTIVATION_STEPS),
  status: z.enum([
    "PENDING",
    "READY",
    "RUNNING",
    "SUCCEEDED",
    "FAILED",
    "BLOCKED",
    "SKIPPED",
    "CANCELLED",
    "WAITING_EXTERNAL",
  ]),
  attempts: z.coerce.number(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  error_message: z.string().nullable(),
  provider: z.string().nullable(),
  external_id: z.string().nullable(),
  ordinal: z.coerce.number(),
});
const workflowRunRowSchema = z.object({
  id: z.string().uuid(),
  run_number: z.string(),
  creator_id: z.string().uuid(),
  status: z.enum(["RUNNING", "WAITING_EXTERNAL", "SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"]),
  started_at: z.string(),
  completed_at: z.string().nullable(),
  correlation_id: z.string().uuid(),
  blockers_json: z.array(z.string()),
  workflow_steps: z.array(workflowStepRowSchema),
});
const resourceRowSchema = z.object({
  external_id: z.string(),
  display_name: z.string().nullable(),
  provider: z.string(),
  environment: z.string(),
});

function requireAdmin() {
  const client = createSupabaseAdminClient();
  if (!client) throw new Error("DATABASE_NOT_CONFIGURED");
  return client;
}

export async function loadLiveOnboardingCreator(
  organizationId: string,
  creatorId: string,
): Promise<OnboardingCreator | null> {
  const admin = requireAdmin();
  const creatorResult = await admin
    .from("creators")
    .select(
      "id,creator_number,stage_name,status,contract_status,adult_confirmation_status,jurisdiction_review_status,email,timezone,assigned_creator_success_user_id,assigned_growth_user_id",
    )
    .eq("organization_id", organizationId)
    .eq("id", creatorId)
    .maybeSingle();
  if (creatorResult.error || !creatorResult.data) return null;
  const [boundary, baseline] = await Promise.all([
    admin
      .from("creator_boundaries")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("creator_id", creatorId)
      .eq("active", true),
    admin
      .from("creator_baselines")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("creator_id", creatorId),
  ]);
  const creator = creatorRowSchema.parse(creatorResult.data);
  return {
    id: creator.id,
    creatorNumber: creator.creator_number,
    stageName: creator.stage_name,
    stageSlug: creator.stage_name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, ""),
    status:
      creator.status === "WATCH" || creator.status === "ACTIVE" ? creator.status : "ONBOARDING",
    contractSigned: ["SIGNED", "ACTIVE"].includes(String(creator.contract_status).toUpperCase()),
    adultConfirmed: ["CONFIRMED", "VERIFIED", "COMPLETE"].includes(
      String(creator.adult_confirmation_status).toUpperCase(),
    ),
    jurisdictionApproved: ["APPROVED", "COMPLETE"].includes(
      String(creator.jurisdiction_review_status).toUpperCase(),
    ),
    contactEmail: creator.email,
    timezone: creator.timezone,
    assignedTeam: Boolean(
      creator.assigned_creator_success_user_id || creator.assigned_growth_user_id,
    ),
    boundariesCollected: (boundary.count ?? 0) > 0,
    baselineReady: (baseline.count ?? 0) > 0,
  };
}

export class SupabaseOnboardingRepository implements OnboardingRepository {
  private currentRun: { id: string; creatorId: string } | null = null;
  constructor(
    private readonly organizationId: string,
    private readonly initiatedBy: string,
  ) {}
  withCreatorLock<T>(_creatorId: string, work: () => Promise<T>) {
    return work();
  }

  async findActiveRun(creatorId: string): Promise<WorkflowRun | null> {
    const result = await requireAdmin()
      .from("workflow_runs")
      .select(
        "id,run_number,creator_id,status,started_at,completed_at,correlation_id,blockers_json,workflow_steps(step_key,status,attempts,started_at,completed_at,error_message,provider,external_id,ordinal)",
      )
      .eq("organization_id", this.organizationId)
      .eq("creator_id", creatorId)
      .not("status", "in", "(SUCCEEDED,CANCELLED)")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (result.error) throw new Error(`WORKFLOW_LOOKUP_FAILED: ${result.error.message}`);
    if (!result.data) return null;
    const row = workflowRunRowSchema.parse(result.data);
    // Durable execution creates a fresh repository per step and enters through
    // findActiveRun rather than saveRun, so the run context has to be
    // established here too. Without it claimProvisioningKey throws
    // WORKFLOW_RUN_CONTEXT_MISSING and every live activation dies at the first
    // provisioning step.
    this.currentRun = { id: row.id, creatorId: row.creator_id };
    const steps = [...row.workflow_steps].sort((a, b) => a.ordinal - b.ordinal);
    if (steps.length === 0) throw new Error(`WORKFLOW_RUN_HAS_NO_STEPS: ${row.id}`);
    return {
      id: row.id,
      runNumber: row.run_number,
      creatorId: row.creator_id,
      workflow: "CREATOR_ACTIVATION_V1",
      status: row.status,
      createdAt: row.started_at,
      completedAt: row.completed_at,
      correlationId: row.correlation_id,
      blockers: row.blockers_json,
      steps: steps.map((step) => ({
        name: step.step_key,
        status: step.status,
        attempts: step.attempts,
        startedAt: step.started_at,
        completedAt: step.completed_at,
        error: step.error_message,
        provider: step.provider,
        externalId: step.external_id,
      })),
    };
  }

  async saveRun(run: WorkflowRun): Promise<void> {
    this.currentRun = { id: run.id, creatorId: run.creatorId };
    const admin = requireAdmin();
    let definition = await admin
      .from("workflow_definitions")
      .select("id")
      .eq("organization_id", this.organizationId)
      .eq("name", "CREATOR_ACTIVATION")
      .eq("version", 1)
      .maybeSingle();
    if (!definition.data) {
      definition = await admin
        .from("workflow_definitions")
        .insert({
          organization_id: this.organizationId,
          name: "CREATOR_ACTIVATION",
          version: 1,
          description: "Deterministic CreatorOS V1 activation",
          steps_json: ACTIVATION_STEPS,
        })
        .select("id")
        .single();
    }
    if (definition.error || !definition.data)
      throw new Error(`WORKFLOW_DEFINITION_FAILED: ${definition.error?.message ?? "unknown"}`);
    const workflowDefinition = z.object({ id: z.string().uuid() }).parse(definition.data);
    const runWrite = await admin.from("workflow_runs").upsert({
      id: run.id,
      organization_id: this.organizationId,
      creator_id: run.creatorId,
      definition_id: workflowDefinition.id,
      run_number: run.runNumber,
      status: run.status,
      // Per run, not per creator. workflow_runs carries an unconditional
      // unique(organization_id, idempotency_key) covering every status, so a
      // constant per-creator key meant a creator could be activated exactly once
      // ever — a second activation after a completed one could not be inserted.
      // The active-run fence is workflow_runs_one_active_creator_definition_uidx,
      // which is partial and only covers non-terminal runs.
      idempotency_key: run.id,
      current_step: run.steps.find((step) => step.status === "RUNNING")?.name ?? null,
      initiated_by: this.initiatedBy,
      correlation_id: run.correlationId,
      blockers_json: run.blockers,
      started_at: run.createdAt,
      completed_at: run.completedAt,
    });
    if (runWrite.error) throw new Error(`WORKFLOW_RUN_SAVE_FAILED: ${runWrite.error.message}`);
    const stepWrite = await admin.from("workflow_steps").upsert(
      run.steps.map((step, ordinal) => ({
        organization_id: this.organizationId,
        workflow_run_id: run.id,
        step_key: step.name,
        ordinal,
        status: step.status,
        attempts: step.attempts,
        started_at: step.startedAt,
        completed_at: step.completedAt,
        error_message: step.error,
        provider: step.provider,
        external_id: step.externalId,
        idempotency_key: `${run.id}:${step.name}`,
      })),
      { onConflict: "workflow_run_id,step_key" },
    );
    if (stepWrite.error) throw new Error(`WORKFLOW_STEPS_SAVE_FAILED: ${stepWrite.error.message}`);
  }

  async claimProvisioningKey(
    key: string,
    resource: ProvisionedResource,
  ): Promise<ProvisionedResource> {
    const admin = requireAdmin();
    const { data } = await admin
      .from("provisioned_resources")
      .select("external_id,display_name,provider,environment")
      .eq("organization_id", this.organizationId)
      .eq("idempotency_key", key)
      .maybeSingle();
    const parsedResource = resourceRowSchema.safeParse(data);
    if (parsedResource.success) {
      if (this.currentRun)
        await admin
          .from("provisioned_resources")
          .update({ workflow_run_id: this.currentRun.id })
          .eq("organization_id", this.organizationId)
          .eq("idempotency_key", key);
      return {
        externalId: parsedResource.data.external_id,
        name: parsedResource.data.display_name ?? parsedResource.data.external_id,
        provider: parsedResource.data.provider,
        mode: parsedResource.data.environment === "mock" ? "MOCK" : resource.mode,
      };
    }
    if (!this.currentRun) throw new Error("WORKFLOW_RUN_CONTEXT_MISSING");
    const insert = await admin.from("provisioned_resources").insert({
      organization_id: this.organizationId,
      creator_id: this.currentRun.creatorId,
      workflow_run_id: this.currentRun.id,
      provider: resource.provider,
      resource_type: "workflow-resource",
      external_id: resource.externalId,
      display_name: resource.name,
      environment: resource.mode === "MOCK" ? "mock" : "live",
      idempotency_key: key,
    });
    if (insert.error) throw new Error(`PROVISIONED_RESOURCE_SAVE_FAILED: ${insert.error.message}`);
    return resource;
  }

  async countRuns(creatorId: string): Promise<number> {
    const result = await requireAdmin()
      .from("workflow_runs")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", this.organizationId)
      .eq("creator_id", creatorId);
    if (result.error) throw new Error(`WORKFLOW_COUNT_FAILED: ${result.error.message}`);
    return result.count ?? 0;
  }
}

export async function createLiveOnboardingService(
  organizationId: string,
  actorUserId: string,
  creatorId: string,
) {
  const [slack, notion] = await Promise.all([
    getIntegrationToken(organizationId, "SLACK"),
    getIntegrationToken(organizationId, "NOTION"),
  ]);
  if (!slack) throw new Error("SLACK_INTEGRATION_NOT_CONNECTED");
  if (!notion) throw new Error("NOTION_INTEGRATION_NOT_CONNECTED");
  const { data: notionConnection, error } = await requireAdmin()
    .from("integration_connections")
    .select("configuration_json")
    .eq("id", notion.connectionId)
    .single();
  const configuration = z
    .object({ configuration_json: z.object({ parentPageId: z.string() }) })
    .safeParse(notionConnection);
  const parentPageId = configuration.success
    ? configuration.data.configuration_json.parentPageId
    : null;
  if (error || typeof parentPageId !== "string")
    throw new Error("NOTION_PARENT_PAGE_NOT_CONFIGURED");
  const repository = new SupabaseOnboardingRepository(organizationId, actorUserId);
  const service = new OnboardingService(repository, {
    slack: new LiveSlackProvider(
      slack.token,
      new SupabaseProviderResourceStore(organizationId, creatorId, "SLACK", "channel"),
    ),
    notion: new LiveNotionProvider(
      notion.token,
      parentPageId,
      new SupabaseProviderResourceStore(organizationId, creatorId, "NOTION", "page"),
    ),
    files: new ManualFileStorageProvider(),
    records: new SupabaseActivationRecordPort(organizationId, actorUserId),
  });
  return { repository, service };
}
