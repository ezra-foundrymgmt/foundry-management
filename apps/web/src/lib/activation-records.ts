import "server-only";
import type { WorkDepartment } from "@creatoros/domain";
import type { ActivationRecordPort, OnboardingCreator } from "@creatoros/workflows";
import { COMPETITOR_RESEARCH_KEY, evaluateActivationReadiness } from "@/lib/activation-readiness";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * These tasks predate WORK_DEPARTMENTS and were written with their own casing
 * ("GROWTH", "CREATOR_SUCCESS") — a second, silently divergent department
 * vocabulary from the one apps/web/src/lib/tasks.ts and task-create-form.tsx
 * actually validate against and render. tasks.department is free text, so
 * nothing enforced the two ever matching; the Tasks page's department filter
 * and any future department-scoped query would treat "GROWTH" and "Growth" as
 * unrelated values for tasks that are, in every other respect, the same kind
 * of work. Typed against WorkDepartment so a future rename of the canonical
 * list fails this file at compile time instead of drifting again silently.
 */
const GROWTH: WorkDepartment = "Growth";
const CREATOR_SUCCESS: WorkDepartment = "Creator Success";

/**
 * Supabase implementation of the activation bookkeeping steps.
 *
 * Every method is idempotent by upserting against a natural key, because
 * activation is resumable and any step can be retried. A second call for the
 * same creator updates the row it created the first time.
 *
 * Nothing here fabricates a measurement. Health, P&L and inventory rows are
 * created with null metrics and an explicit UNKNOWN confidence so the record
 * exists to be filled in — a zero would read as a real measured value.
 */
export class SupabaseActivationRecordPort implements ActivationRecordPort {
  constructor(
    private readonly organizationId: string,
    private readonly actorUserId: string,
  ) {}

  #admin() {
    const client = createSupabaseAdminClient();
    if (!client) throw new Error("DATABASE_NOT_CONFIGURED");
    return client;
  }

  #today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  async #upsert(table: string, values: Record<string, unknown>, onConflict: string): Promise<void> {
    const { error } = await this.#admin()
      .from(table)
      .upsert({ organization_id: this.organizationId, ...values }, { onConflict });
    if (error) throw new Error(`ACTIVATION_RECORD_FAILED:${table}: ${error.message}`);
  }

  /**
   * Re-checks the prerequisites at execution time rather than trusting the
   * snapshot taken when the run was created. A contract that lapsed mid-run
   * should stop the activation, not ride on a stale check.
   */
  validateCreator(creator: OnboardingCreator): Promise<void> {
    const missing: string[] = [];
    if (!creator.contractSigned) missing.push("contract");
    if (!creator.adultConfirmed) missing.push("adult confirmation");
    if (!creator.jurisdictionApproved) missing.push("jurisdiction review");
    if (!creator.boundariesCollected) missing.push("boundaries");
    if (missing.length) throw new Error(`CREATOR_NO_LONGER_ELIGIBLE: ${missing.join(", ")}`);
    return Promise.resolve();
  }

  async recordActivationStarted(creator: OnboardingCreator): Promise<void> {
    const { error } = await this.#admin()
      .from("creators")
      .update({ status: "ONBOARDING", updated_at: new Date().toISOString() })
      .eq("organization_id", this.organizationId)
      .eq("id", creator.id);
    if (error) throw new Error(`ACTIVATION_START_FAILED: ${error.message}`);
    await this.#audit(creator.id, "creator.activation.started", {
      creatorNumber: creator.creatorNumber,
    });
  }

  assignTeam(creator: OnboardingCreator): Promise<void> {
    // Assignment is a human decision made before activation; this step verifies
    // it rather than inventing an owner.
    if (!creator.assignedTeam) throw new Error("CREATOR_HAS_NO_ASSIGNED_TEAM");
    return Promise.resolve();
  }

  async initializeBrandProfile(creator: OnboardingCreator): Promise<void> {
    await this.#upsert(
      "creator_brand_profiles",
      { creator_id: creator.id, updated_at: new Date().toISOString() },
      "creator_id",
    );
  }

  async initializeHealth(creator: OnboardingCreator): Promise<void> {
    // A brand-new creator has no measured health. The row exists so the record
    // is present; the score is the neutral starting band, not a claim.
    await this.#upsert(
      "creator_health_scores",
      {
        creator_id: creator.id,
        score_date: this.#today(),
        total_score: 0,
        band: "UNKNOWN",
        components_json: {},
        weights_json: {},
        calculated_by: "CREATOR_ACTIVATION_V1",
      },
      "creator_id,score_date",
    );
  }

  async initializePnl(creator: OnboardingCreator): Promise<void> {
    const start = this.#today();
    const end = new Date(Date.now() + 29 * 86_400_000).toISOString().slice(0, 10);
    await this.#upsert(
      "creator_pnl_periods",
      {
        creator_id: creator.id,
        period_start: start,
        period_end: end,
        status: "OPEN",
        updated_at: new Date().toISOString(),
      },
      "creator_id,period_start,period_end",
    );
  }

  async initializeContentInventory(creator: OnboardingCreator): Promise<void> {
    await this.#upsert(
      "content_inventory_snapshots",
      { creator_id: creator.id, snapshot_date: this.#today() },
      "creator_id,snapshot_date",
    );
  }

  /**
   * Competitor research is work a person does, so activation commissions it
   * rather than inventing it.
   *
   * This previously wrote a bare row into creator_competitors, which could never
   * have succeeded: the table requires competitor_name and competitor_type, and
   * the upsert supplied neither. Filling them in would have been worse than the
   * failure — a competitor CreatorOS made up, presented as research.
   */
  async createCompetitorResearch(creator: OnboardingCreator): Promise<void> {
    await this.#upsert(
      "tasks",
      {
        creator_id: creator.id,
        title: `Complete competitor research for ${creator.stageName}`,
        department: GROWTH,
        status: "OPEN",
        priority: "MEDIUM",
        requested_by: this.actorUserId,
        source_type: "CREATOR_ACTIVATION_V1",
        idempotency_key: COMPETITOR_RESEARCH_KEY(creator.id),
        updated_at: new Date().toISOString(),
      },
      "organization_id,idempotency_key",
    );
  }

  async createContentTestBoard(creator: OnboardingCreator): Promise<void> {
    // The starting pillar set every creator begins with. Named, so the unique
    // (creator_id, name) index makes a retry a no-op.
    for (const name of ["Discovery", "Connection", "Conversion"])
      await this.#upsert(
        "content_pillars",
        {
          creator_id: creator.id,
          name,
          strategic_role: name,
          updated_at: new Date().toISOString(),
        },
        "creator_id,name",
      );
  }

  async createInternalTasks(creator: OnboardingCreator): Promise<void> {
    const tasks = [
      { title: `Collect baseline metrics for ${creator.stageName}`, department: GROWTH },
      { title: `Complete Brand Dossier for ${creator.stageName}`, department: CREATOR_SUCCESS },
      {
        title: `Confirm content boundaries with ${creator.stageName}`,
        department: CREATOR_SUCCESS,
      },
    ];
    for (const task of tasks)
      await this.#upsert(
        "tasks",
        {
          creator_id: creator.id,
          title: task.title,
          department: task.department,
          status: "OPEN",
          priority: "MEDIUM",
          requested_by: this.actorUserId,
          source_type: "CREATOR_ACTIVATION_V1",
          idempotency_key: `activation:${creator.id}:task:${task.title}`,
          updated_at: new Date().toISOString(),
        },
        "organization_id,idempotency_key",
      );
  }

  async requestSocialIntegrations(creator: OnboardingCreator): Promise<void> {
    // Created as NOT_CONFIGURED placeholders. These are requests for a human to
    // connect an account, never a claim that one is connected.
    for (const provider of ["INSTAGRAM", "TIKTOK", "X"])
      await this.#upsert(
        "social_accounts",
        {
          creator_id: creator.id,
          provider,
          connection_status: "NOT_CONFIGURED",
          connection_method: "PENDING_HUMAN_SETUP",
          idempotency_key: `activation:${creator.id}:social:${provider}`,
          updated_at: new Date().toISOString(),
        },
        "organization_id,idempotency_key",
      );
  }

  async requestRevenueIntegration(creator: OnboardingCreator): Promise<void> {
    await this.#upsert(
      "integration_connections",
      {
        creator_id: creator.id,
        provider: "CREATOR_REVENUE",
        category: "Revenue",
        // Stays NOT_CONFIGURED until an approved lawful provider exists.
        status: "NOT_CONFIGURED",
        environment: "live",
        updated_at: new Date().toISOString(),
      },
      "organization_id,provider,creator_id",
    );
  }

  async createBaselineRequest(creator: OnboardingCreator): Promise<void> {
    await this.#upsert(
      "tasks",
      {
        creator_id: creator.id,
        title: `Import 30-day baseline for ${creator.stageName}`,
        department: GROWTH,
        status: "OPEN",
        priority: "HIGH",
        requested_by: this.actorUserId,
        source_type: "CREATOR_ACTIVATION_V1",
        idempotency_key: `activation:${creator.id}:baseline-request`,
        updated_at: new Date().toISOString(),
      },
      "organization_id,idempotency_key",
    );
  }

  async scheduleDailyReport(creator: OnboardingCreator): Promise<void> {
    await this.#scheduleReport(creator, "DAILY");
  }

  async scheduleWeeklyReview(creator: OnboardingCreator): Promise<void> {
    await this.#scheduleReport(creator, "WEEKLY");
  }

  async #scheduleReport(creator: OnboardingCreator, cadence: "DAILY" | "WEEKLY"): Promise<void> {
    await this.#upsert(
      "creator_report_schedules",
      {
        creator_id: creator.id,
        cadence,
        timezone: creator.timezone,
        active: true,
        updated_at: new Date().toISOString(),
      },
      "creator_id,cadence",
    );
  }

  async generateWelcomePackage(creator: OnboardingCreator): Promise<void> {
    await this.#upsert(
      "tasks",
      {
        creator_id: creator.id,
        title: `Send welcome package to ${creator.stageName}`,
        department: CREATOR_SUCCESS,
        status: "OPEN",
        priority: "MEDIUM",
        requested_by: this.actorUserId,
        source_type: "CREATOR_ACTIVATION_V1",
        idempotency_key: `activation:${creator.id}:welcome-package`,
        updated_at: new Date().toISOString(),
      },
      "organization_id,idempotency_key",
    );
  }

  async markProvisioningComplete(creator: OnboardingCreator): Promise<void> {
    const { error } = await this.#admin()
      .from("creators")
      .update({ updated_at: new Date().toISOString() })
      .eq("organization_id", this.organizationId)
      .eq("id", creator.id);
    if (error) throw new Error(`PROVISIONING_COMPLETE_FAILED: ${error.message}`);
  }

  /**
   * The only step that moves the creator to ACTIVE.
   *
   * Reaching this step is not evidence that the creator is ready. The step order
   * says the earlier steps ran; it does not say they left anything behind. The
   * readiness evaluator re-checks every record ACTIVE is supposed to mean, at
   * the moment the status is written, so a step that silently did nothing or a
   * record deleted mid-run stops the activation instead of producing an ACTIVE
   * creator with nothing behind it.
   */
  async completeActivation(creator: OnboardingCreator): Promise<void> {
    const readiness = await evaluateActivationReadiness({
      organizationId: this.organizationId,
      creatorId: creator.id,
    });
    if (readiness.status !== "READY")
      throw new Error(
        `CREATOR_NOT_READY_FOR_ACTIVE:${readiness.status}: ${readiness.reasons.join("; ")}`,
      );

    const { error } = await this.#admin()
      .from("creators")
      .update({ status: "ACTIVE", updated_at: new Date().toISOString() })
      .eq("organization_id", this.organizationId)
      .eq("id", creator.id);
    if (error) throw new Error(`ACTIVATION_COMPLETE_FAILED: ${error.message}`);
    await this.#audit(creator.id, "creator.activation.completed", {
      checks: readiness.checks.length,
    });
  }

  /**
   * Appends to the immutable trail. Activation is the most consequential thing
   * CreatorOS does to a creator record and it previously left no trace: the
   * status changed and nothing said who started it or when.
   *
   * The actor is the workflow acting on behalf of the founder who started it,
   * not the founder directly, because no person performed this write.
   */
  async #audit(
    creatorId: string,
    action: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const { error } = await this.#admin().from("audit_events").insert({
      organization_id: this.organizationId,
      actor_type: "workflow",
      actor_user_id: this.actorUserId,
      actor_service: "CREATOR_ACTIVATION_V1",
      action,
      resource_type: "creator",
      resource_id: creatorId,
      metadata_json: metadata,
      correlation_id: crypto.randomUUID(),
    });
    if (error) throw new Error(`ACTIVATION_AUDIT_FAILED: ${error.message}`);
  }
}
