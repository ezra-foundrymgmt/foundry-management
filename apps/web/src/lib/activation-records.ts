import "server-only";
import { z } from "zod";
import {
  composeWelcomePackage,
  readCommissionRate,
  renderWelcomePackage,
  type WelcomePackage,
  type WorkDepartment,
} from "@creatoros/domain";
import type { ActivationRecordPort, OnboardingCreator } from "@creatoros/workflows";
import { COMPETITOR_RESEARCH_KEY, evaluateActivationReadiness } from "@/lib/activation-readiness";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * Shapes for the welcome package's inputs.
 *
 * Every one is parsed with safeParse and degrades to an absent section rather
 * than throwing: the package is composed inside an activation step, and a
 * malformed row must not strand a creator mid-onboarding.
 */
const welcomeMetricsSchema = z.object({
  date: z.string(),
  reach: z.coerce.number(),
  profileVisits: z.coerce.number(),
  outboundClicks: z.coerce.number(),
  newSubscribers: z.coerce.number(),
  firstBuyers: z.coerce.number(),
  revenue: z.coerce.number(),
  unmeasuredDimensions: z.array(z.string()).default([]),
});
const welcomeUserSchema = z.array(
  z.object({ id: z.string(), display_name: z.string().nullable(), email: z.string() }),
);
const welcomeBoundarySchema = z.array(
  z.object({
    boundary_type: z.string().nullable(),
    description: z.string().nullable(),
    severity: z.string().nullable(),
  }),
);
const welcomeTaskSchema = z.array(
  z.object({
    title: z.string(),
    department: z.string().nullable(),
    due_at: z.string().nullable(),
  }),
);
const welcomeCommissionSchema = z.object({ commission_rate: z.coerce.number().nullable() });

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

  /**
   * Opens the creator's first P&L period, carrying the organisation's default
   * commission rate onto it.
   *
   * The rate used to be left null here, which is why the first real welcome
   * package could not state the commercial terms: nothing in activation ever
   * supplied one, and the package correctly refused to invent it. Reading the
   * organisation default means a creator on standard terms is complete from
   * the moment they are activated, while a negotiated rate can still be written
   * onto this row afterwards.
   */
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
        commission_rate: await this.#commissionRate(),
        updated_at: new Date().toISOString(),
      },
      "creator_id,period_start,period_end",
    );
  }

  /**
   * The organisation's standard commission rate.
   *
   * Falls back rather than throwing: a missing or malformed setting must not
   * strand a creator mid-activation, and readCommissionRate already refuses
   * anything outside (0, 1).
   */
  async #commissionRate(): Promise<number> {
    const { data } = await this.#admin()
      .from("organizations")
      .select("settings_json")
      .eq("id", this.organizationId)
      .maybeSingle();
    return readCommissionRate((data as { settings_json?: unknown } | null)?.settings_json);
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

  /**
   * Composes the welcome package and stores it on the task that asks for it.
   *
   * This step used to create a bare "Send welcome package to X" reminder and
   * stop — the system's entire contribution to the artifact a creator judges
   * Foundry on was a to-do item. It now assembles the real document from what
   * CreatorOS already holds and writes it into the task description, so the
   * operator opens the task and finds the thing rather than a prompt to write
   * it.
   *
   * When the package is incomplete the task says which inputs are missing and
   * is raised to HIGH, because sending a welcome document with a hole in it is
   * worse than sending it late.
   */
  async generateWelcomePackage(creator: OnboardingCreator): Promise<void> {
    const pkg = await this.#composeWelcomePackage(creator);
    const complete = pkg.blockingGaps.length === 0;
    await this.#upsert(
      "tasks",
      {
        creator_id: creator.id,
        title: complete
          ? `Send welcome package to ${creator.stageName}`
          : `Complete welcome package for ${creator.stageName} (${pkg.blockingGaps.length} gap${pkg.blockingGaps.length === 1 ? "" : "s"})`,
        description: renderWelcomePackage(pkg),
        department: CREATOR_SUCCESS,
        status: "OPEN",
        priority: complete ? "MEDIUM" : "HIGH",
        requested_by: this.actorUserId,
        source_type: "CREATOR_ACTIVATION_V1",
        idempotency_key: `activation:${creator.id}:welcome-package`,
        updated_at: new Date().toISOString(),
      },
      "organization_id,idempotency_key",
    );
  }

  /**
   * Gathers the package's inputs from the records activation has already
   * written.
   *
   * Every read is best-effort: a failure here must degrade the document to a
   * stated gap, never fail the activation step. A welcome package that cannot
   * be composed is a task the operator finishes by hand; a failed activation is
   * a creator stuck in onboarding.
   */
  async #composeWelcomePackage(creator: OnboardingCreator): Promise<WelcomePackage> {
    const admin = this.#admin();
    const scope = { organization_id: this.organizationId, creator_id: creator.id };

    const [baselineRow, boundaryRows, taskRows, ownerRows, scheduleRow, pnlRow] = await Promise.all([
      admin
        .from("creator_baselines")
        .select("metrics_json,period_start,period_end")
        .match(scope)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle(),
      admin
        .from("creator_boundaries")
        .select("boundary_type,description,severity")
        .match(scope)
        .eq("active", true),
      admin
        .from("tasks")
        .select("title,department,due_at")
        .match(scope)
        .eq("source_type", "CREATOR_ACTIVATION_V1"),
      admin
        .from("creators")
        .select("assigned_creator_success_user_id,assigned_growth_user_id")
        .eq("organization_id", this.organizationId)
        .eq("id", creator.id)
        .maybeSingle(),
      admin
        .from("creator_report_schedules")
        .select("cadence")
        .match(scope)
        .eq("active", true)
        .order("cadence", { ascending: true })
        .limit(1)
        .maybeSingle(),
      admin
        .from("creator_pnl_periods")
        .select("commission_rate")
        .match(scope)
        .order("period_start", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const metrics = welcomeMetricsSchema.safeParse(baselineRow.data?.metrics_json);
    const period = baselineRow.data as { period_start?: string; period_end?: string } | null;

    const owners = ownerRows.data as {
      assigned_creator_success_user_id?: string | null;
      assigned_growth_user_id?: string | null;
    } | null;
    const ownerIds = [
      owners?.assigned_creator_success_user_id,
      owners?.assigned_growth_user_id,
    ].filter((id): id is string => typeof id === "string");
    const team: Array<{ name: string; role: string }> = [];
    if (ownerIds.length > 0) {
      const people = await admin.from("users").select("id,display_name,email").in("id", ownerIds);
      const parsed = welcomeUserSchema.safeParse(people.data ?? []);
      if (parsed.success)
        for (const person of parsed.data)
          team.push({
            name: person.display_name ?? person.email,
            role:
              person.id === owners?.assigned_creator_success_user_id ? "Creator Success" : "Growth",
          });
    }

    const boundaries = welcomeBoundarySchema.safeParse(boundaryRows.data ?? []);
    const commitments = welcomeTaskSchema.safeParse(taskRows.data ?? []);
    const commission = welcomeCommissionSchema.safeParse(pnlRow.data);
    const cadence = (scheduleRow.data as { cadence?: string } | null)?.cadence;

    return composeWelcomePackage({
      stageName: creator.stageName,
      team,
      baseline:
        metrics.success && period?.period_start && period?.period_end
          ? {
              metrics: metrics.data,
              periodStart: period.period_start,
              periodEnd: period.period_end,
              unmeasuredDimensions: metrics.data.unmeasuredDimensions,
              dataConfidence: "MEASURED",
            }
          : null,
      boundaries: boundaries.success
        ? boundaries.data.map((row) => ({
            boundaryType: row.boundary_type ?? "GENERAL",
            description: row.description ?? "",
            severity: row.severity ?? "UNKNOWN",
          }))
        : [],
      commitments: commitments.success
        ? commitments.data.map((row) => ({
            title: row.title,
            owner: row.department ?? "Foundry",
            dueAt: row.due_at ? row.due_at.slice(0, 10) : null,
          }))
        : [],
      commissionRate: commission.success ? commission.data.commission_rate : null,
      reportingCadence: cadence === "DAILY" || cadence === "WEEKLY" ? cadence : null,
      creatorTimezone: creator.timezone,
    });
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
