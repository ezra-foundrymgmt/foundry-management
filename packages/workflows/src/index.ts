import type {
  FileStorageProvider,
  NotionProvider,
  ProvisionedResource,
  SlackProvider,
} from "@creatoros/integrations";

export const ACTIVATION_STEPS = [
  "VALIDATE_CREATOR",
  "LOCK_IDEMPOTENCY",
  "CREATE_ACTIVATION",
  "ASSIGN_TEAM",
  "INITIALIZE_BRAND_PROFILE",
  "INITIALIZE_HEALTH",
  "INITIALIZE_PNL",
  "INITIALIZE_CONTENT_INVENTORY",
  "CREATE_COMPETITOR_RESEARCH",
  "CREATE_CONTENT_TEST_BOARD",
  "CREATE_INTERNAL_TASKS",
  "PROVISION_SLACK_CREATOR",
  "PROVISION_SLACK_INTERNAL",
  "PROVISION_NOTION_HUB",
  "PROVISION_NOTION_INTERNAL",
  "PROVISION_FILE_STRUCTURE",
  "REQUEST_SOCIAL_INTEGRATIONS",
  "REQUEST_REVENUE_INTEGRATION",
  "CREATE_BASELINE_REQUEST",
  "SCHEDULE_DAILY_REPORT",
  "SCHEDULE_WEEKLY_REVIEW",
  "GENERATE_WELCOME_PACKAGE",
  "POST_WELCOME_NOTIFICATION",
  "MARK_PROVISIONING_COMPLETE",
  "AWAIT_BASELINE_READINESS",
  "COMPLETE_ACTIVATION",
] as const;
export type ActivationStepName = (typeof ACTIVATION_STEPS)[number];

export const OFFBOARDING_STEPS = [
  "VALIDATE_OFFBOARDING_APPROVAL",
  "REVOKE_FOUNDRY_ACCESS",
  "DISCONNECT_INTEGRATIONS",
  "PREPARE_PERMITTED_DATA_EXPORT",
  "ARCHIVE_OPEN_TASKS",
  "ARCHIVE_NOTION_PROJECTIONS",
  "ARCHIVE_SLACK_CHANNELS",
  "REQUEST_FINAL_FINANCIAL_RECONCILIATION",
  "MARK_CREATOR_FORMER",
] as const;
export type OffboardingStepName = (typeof OFFBOARDING_STEPS)[number];
export type WorkflowStepStatus =
  | "PENDING"
  | "READY"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "BLOCKED"
  | "SKIPPED"
  | "CANCELLED"
  | "WAITING_EXTERNAL";

export interface OnboardingCreator {
  id: string;
  creatorNumber: string;
  stageName: string;
  stageSlug: string;
  status: "ONBOARDING" | "ACTIVE" | "WATCH";
  contractSigned: boolean;
  adultConfirmed: boolean;
  jurisdictionApproved: boolean;
  contactEmail: string | null;
  timezone: string | null;
  assignedTeam: boolean;
  boundariesCollected: boolean;
  baselineReady: boolean;
}

export interface WorkflowStepRecord {
  name: ActivationStepName;
  status: WorkflowStepStatus;
  attempts: number;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  provider: string | null;
  externalId: string | null;
}

export interface WorkflowRun {
  id: string;
  runNumber: string;
  creatorId: string;
  workflow: "CREATOR_ACTIVATION_V1";
  status: "RUNNING" | "WAITING_EXTERNAL" | "SUCCEEDED" | "FAILED" | "BLOCKED" | "CANCELLED";
  createdAt: string;
  completedAt: string | null;
  correlationId: string;
  blockers: string[];
  steps: WorkflowStepRecord[];
}

export interface OnboardingRepository {
  withCreatorLock<T>(creatorId: string, work: () => Promise<T>): Promise<T>;
  findActiveRun(creatorId: string): Promise<WorkflowRun | null>;
  saveRun(run: WorkflowRun): Promise<void>;
  claimProvisioningKey(key: string, resource: ProvisionedResource): Promise<ProvisionedResource>;
  countRuns(creatorId: string): Promise<number>;
}

export class MemoryOnboardingRepository implements OnboardingRepository {
  readonly #runs = new Map<string, WorkflowRun>();
  readonly #provisioning = new Map<string, ProvisionedResource>();
  readonly #locks = new Map<string, Promise<void>>();

  async withCreatorLock<T>(creatorId: string, work: () => Promise<T>): Promise<T> {
    const prior = this.#locks.get(creatorId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = prior.then(() => current);
    this.#locks.set(creatorId, queued);
    await prior;
    try {
      return await work();
    } finally {
      release();
      if (this.#locks.get(creatorId) === queued) this.#locks.delete(creatorId);
    }
  }

  findActiveRun(creatorId: string): Promise<WorkflowRun | null> {
    return Promise.resolve(
      [...this.#runs.values()].find(
        (run) => run.creatorId === creatorId && !["SUCCEEDED", "CANCELLED"].includes(run.status),
      ) ?? null,
    );
  }
  saveRun(run: WorkflowRun): Promise<void> {
    this.#runs.set(run.id, structuredClone(run));
    return Promise.resolve();
  }
  claimProvisioningKey(key: string, resource: ProvisionedResource): Promise<ProvisionedResource> {
    const existing = this.#provisioning.get(key);
    if (existing) return Promise.resolve(existing);
    this.#provisioning.set(key, resource);
    return Promise.resolve(resource);
  }
  countRuns(creatorId: string): Promise<number> {
    return Promise.resolve(
      [...this.#runs.values()].filter((run) => run.creatorId === creatorId).length,
    );
  }
}

/**
 * The CreatorOS records an activation is responsible for creating.
 *
 * Sixteen of the twenty-six activation steps are internal bookkeeping, not
 * external provisioning. They previously returned null and were marked
 * SUCCEEDED without touching anything, so a "completed" activation did not
 * imply a brand profile, a P&L period, internal tasks or a report schedule
 * existed. This port is how those steps do real work while the orchestration
 * itself stays free of database access.
 *
 * Every method MUST be idempotent: activation is resumable and each step can be
 * retried, so a second call for the same creator must not create a second row.
 */
export interface ActivationRecordPort {
  validateCreator(creator: OnboardingCreator): Promise<void>;
  recordActivationStarted(creator: OnboardingCreator): Promise<void>;
  assignTeam(creator: OnboardingCreator): Promise<void>;
  initializeBrandProfile(creator: OnboardingCreator): Promise<void>;
  initializeHealth(creator: OnboardingCreator): Promise<void>;
  initializePnl(creator: OnboardingCreator): Promise<void>;
  initializeContentInventory(creator: OnboardingCreator): Promise<void>;
  createCompetitorResearch(creator: OnboardingCreator): Promise<void>;
  createContentTestBoard(creator: OnboardingCreator): Promise<void>;
  createInternalTasks(creator: OnboardingCreator): Promise<void>;
  requestSocialIntegrations(creator: OnboardingCreator): Promise<void>;
  requestRevenueIntegration(creator: OnboardingCreator): Promise<void>;
  createBaselineRequest(creator: OnboardingCreator): Promise<void>;
  scheduleDailyReport(creator: OnboardingCreator): Promise<void>;
  scheduleWeeklyReview(creator: OnboardingCreator): Promise<void>;
  generateWelcomePackage(creator: OnboardingCreator): Promise<void>;
  markProvisioningComplete(creator: OnboardingCreator): Promise<void>;
  completeActivation(creator: OnboardingCreator): Promise<void>;
}

/** Records every call so tests can assert a step actually did its work. */
export class MemoryActivationRecordPort implements ActivationRecordPort {
  readonly calls: string[] = [];
  #record(name: string) {
    this.calls.push(name);
    return Promise.resolve();
  }
  validateCreator() {
    return this.#record("validateCreator");
  }
  recordActivationStarted() {
    return this.#record("recordActivationStarted");
  }
  assignTeam() {
    return this.#record("assignTeam");
  }
  initializeBrandProfile() {
    return this.#record("initializeBrandProfile");
  }
  initializeHealth() {
    return this.#record("initializeHealth");
  }
  initializePnl() {
    return this.#record("initializePnl");
  }
  initializeContentInventory() {
    return this.#record("initializeContentInventory");
  }
  createCompetitorResearch() {
    return this.#record("createCompetitorResearch");
  }
  createContentTestBoard() {
    return this.#record("createContentTestBoard");
  }
  createInternalTasks() {
    return this.#record("createInternalTasks");
  }
  requestSocialIntegrations() {
    return this.#record("requestSocialIntegrations");
  }
  requestRevenueIntegration() {
    return this.#record("requestRevenueIntegration");
  }
  createBaselineRequest() {
    return this.#record("createBaselineRequest");
  }
  scheduleDailyReport() {
    return this.#record("scheduleDailyReport");
  }
  scheduleWeeklyReview() {
    return this.#record("scheduleWeeklyReview");
  }
  generateWelcomePackage() {
    return this.#record("generateWelcomePackage");
  }
  markProvisioningComplete() {
    return this.#record("markProvisioningComplete");
  }
  completeActivation() {
    return this.#record("completeActivation");
  }
}

export interface OnboardingProviders {
  slack: SlackProvider;
  notion: NotionProvider;
  files: FileStorageProvider;
  /** Defaults to an in-memory recorder so existing callers and tests still work. */
  records?: ActivationRecordPort;
}

export class OnboardingService {
  get #records(): ActivationRecordPort {
    this.providers.records ??= new MemoryActivationRecordPort();
    return this.providers.records;
  }

  constructor(
    private readonly repository: OnboardingRepository,
    private readonly providers: OnboardingProviders,
  ) {}

  /**
   * Creates (or returns) the active run without executing any step. Durable
   * executors need this separately from start() so run creation is its own
   * checkpoint and the steps that follow are each checkpointed individually.
   */
  async createRun(creator: OnboardingCreator): Promise<WorkflowRun> {
    return this.repository.withCreatorLock(creator.id, () => this.#createRunLocked(creator));
  }

  async start(creator: OnboardingCreator): Promise<WorkflowRun> {
    return this.repository.withCreatorLock(creator.id, async () => {
      const run = await this.#createRunLocked(creator);
      if (run.blockers.length > 0) return run;
      const existingSucceeded = run.steps.every((step) => step.status === "SUCCEEDED");
      if (existingSucceeded) return run;
      return this.#execute(run, creator);
    });
  }

  async #createRunLocked(creator: OnboardingCreator): Promise<WorkflowRun> {
    const existing = await this.repository.findActiveRun(creator.id);
    if (existing) {
      // A BLOCKED run is a parked decision, not a completed one -- unlike
      // every other non-terminal status, nothing else in this class ever
      // re-derives it. Returning it unchanged meant a creator whose
      // prerequisites were later fixed could never activate again: the DB's
      // one-active-run-per-creator index made a fresh run impossible to
      // create, and neither this function nor advance() ever re-checked
      // whether the original reason still held.
      if (existing.status !== "BLOCKED") return existing;
      const blockers = this.#prerequisiteBlockers(creator);
      if (blockers.length > 0) {
        if (blockers.join(" ") !== existing.blockers.join(" ")) {
          existing.blockers = blockers;
          await this.repository.saveRun(existing);
        }
        return existing;
      }
      existing.status = "RUNNING";
      existing.blockers = [];
      await this.repository.saveRun(existing);
      return existing;
    }
    const blockers = this.#prerequisiteBlockers(creator);
    const now = new Date().toISOString();
    const run: WorkflowRun = {
      id: crypto.randomUUID(),
      runNumber: `ONB-${new Date().getUTCFullYear()}-${creator.creatorNumber.slice(3).padStart(6, "0")}`,
      creatorId: creator.id,
      workflow: "CREATOR_ACTIVATION_V1",
      status: blockers.length > 0 ? "BLOCKED" : "RUNNING",
      createdAt: now,
      completedAt: null,
      correlationId: crypto.randomUUID(),
      blockers,
      steps: ACTIVATION_STEPS.map((name) => ({
        name,
        status: "PENDING",
        attempts: 0,
        startedAt: null,
        completedAt: null,
        error: null,
        provider: null,
        externalId: null,
      })),
    };
    await this.repository.saveRun(run);
    return run;
  }

  async resume(run: WorkflowRun, creator: OnboardingCreator): Promise<WorkflowRun> {
    return this.repository.withCreatorLock(creator.id, () => this.#execute(run, creator));
  }

  #prerequisiteBlockers(creator: OnboardingCreator): string[] {
    const blockers: string[] = [];
    if (!creator.contractSigned) blockers.push("Signed contract required");
    if (!creator.adultConfirmed) blockers.push("Adult confirmation required");
    if (!creator.jurisdictionApproved) blockers.push("Jurisdiction review required");
    if (!creator.contactEmail) blockers.push("Creator contact email required");
    if (!creator.timezone) blockers.push("Creator timezone required");
    if (!creator.assignedTeam) blockers.push("Assigned Foundry team required");
    if (!creator.boundariesCollected) blockers.push("Creator boundaries collection required");
    return blockers;
  }

  /** A run is finished, for this invocation, in any of these states. */
  static isTerminal(run: WorkflowRun): boolean {
    return ["SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED", "WAITING_EXTERNAL"].includes(run.status);
  }

  /**
   * Executes exactly one step and persists the result. Durable executors call
   * this once per checkpoint so an interrupted activation resumes at the step
   * boundary it actually reached, rather than replaying the whole sequence.
   */
  async advance(run: WorkflowRun, creator: OnboardingCreator): Promise<WorkflowRun> {
    const step = run.steps.find((candidate) => candidate.status !== "SUCCEEDED");
    if (!step) {
      run.status = "SUCCEEDED";
      run.completedAt = new Date().toISOString();
      await this.repository.saveRun(run);
      return run;
    }
    // Re-evaluated on every pass, never skipped because it is already
    // WAITING_EXTERNAL: skipping it let a resume walk straight past the gate and
    // complete an activation whose baseline data had still never arrived.
    if (step.name === "AWAIT_BASELINE_READINESS" && !creator.baselineReady) {
      step.status = "WAITING_EXTERNAL";
      step.completedAt = new Date().toISOString();
      run.status = "WAITING_EXTERNAL";
      await this.repository.saveRun(run);
      return run;
    }
    run.status = "RUNNING";
    step.status = "RUNNING";
    step.startedAt = new Date().toISOString();
    step.attempts += 1;
    try {
      const resource = await this.#executeStep(step.name, creator, run);
      step.status = "SUCCEEDED";
      step.completedAt = new Date().toISOString();
      step.error = null;
      if (resource) {
        step.provider = resource.provider;
        step.externalId = resource.externalId;
      }
      await this.repository.saveRun(run);
    } catch (error) {
      step.status = "FAILED";
      step.error = error instanceof Error ? error.message : "UNKNOWN_WORKFLOW_ERROR";
      run.status = "FAILED";
      await this.repository.saveRun(run);
    }
    return run;
  }

  async #execute(run: WorkflowRun, creator: OnboardingCreator): Promise<WorkflowRun> {
    run.status = "RUNNING";
    let current = run;
    while (!OnboardingService.isTerminal(current)) current = await this.advance(current, creator);
    return current;
  }

  async #executeStep(
    name: ActivationStepName,
    creator: OnboardingCreator,
    run: WorkflowRun,
  ): Promise<ProvisionedResource | null> {
    const prefix = `creator:${creator.id}`;
    if (name === "PROVISION_SLACK_CREATOR") {
      const key = `${prefix}:slack:creator-channel:v1`;
      return this.repository.claimProvisioningKey(
        key,
        await this.providers.slack.createChannel({
          creatorId: creator.id,
          stageSlug: creator.stageSlug,
          audience: "creator",
          idempotencyKey: key,
        }),
      );
    }
    if (name === "PROVISION_SLACK_INTERNAL") {
      const key = `${prefix}:slack:internal-channel:v1`;
      return this.repository.claimProvisioningKey(
        key,
        await this.providers.slack.createChannel({
          creatorId: creator.id,
          stageSlug: creator.stageSlug,
          audience: "internal",
          idempotencyKey: key,
        }),
      );
    }
    if (name === "PROVISION_NOTION_HUB") {
      const key = `${prefix}:notion:creator-hub:v1`;
      return this.repository.claimProvisioningKey(
        key,
        await this.providers.notion.createCreatorHub({
          creatorId: creator.id,
          stageName: creator.stageName,
          idempotencyKey: key,
        }),
      );
    }
    if (name === "PROVISION_NOTION_INTERNAL") {
      const key = `${prefix}:notion:internal:v1`;
      return this.repository.claimProvisioningKey(
        key,
        await this.providers.notion.createInternalResources({
          creatorId: creator.id,
          stageName: creator.stageName,
          idempotencyKey: key,
        }),
      );
    }
    if (name === "PROVISION_FILE_STRUCTURE") {
      const key = `${prefix}:files:structure:v1`;
      return this.repository.claimProvisioningKey(
        key,
        await this.providers.files.createCreatorStructure({
          creatorId: creator.id,
          stageSlug: creator.stageSlug,
          idempotencyKey: key,
        }),
      );
    }

    if (name === "POST_WELCOME_NOTIFICATION") {
      // Posts into the channel PROVISION_SLACK_CREATOR actually created, read
      // from the persisted run rather than reconstructed, so this cannot post
      // into a channel that was never provisioned.
      const channel = run.steps.find((step) => step.name === "PROVISION_SLACK_CREATOR")?.externalId;
      if (!channel) throw new Error("WELCOME_NOTIFICATION_WITHOUT_CHANNEL");
      await this.providers.slack.postMessage(
        channel,
        `Welcome to Foundry, ${creator.stageName}. This channel is where your Foundry team coordinates with you.`,
      );
      return null;
    }

    // Everything below records CreatorOS state. Each is idempotent, so a retry
    // or a resume repeats the call without creating a second row.
    const records = this.#records;
    const recorders: Partial<Record<ActivationStepName, () => Promise<void>>> = {
      VALIDATE_CREATOR: () => records.validateCreator(creator),
      CREATE_ACTIVATION: () => records.recordActivationStarted(creator),
      ASSIGN_TEAM: () => records.assignTeam(creator),
      INITIALIZE_BRAND_PROFILE: () => records.initializeBrandProfile(creator),
      INITIALIZE_HEALTH: () => records.initializeHealth(creator),
      INITIALIZE_PNL: () => records.initializePnl(creator),
      INITIALIZE_CONTENT_INVENTORY: () => records.initializeContentInventory(creator),
      CREATE_COMPETITOR_RESEARCH: () => records.createCompetitorResearch(creator),
      CREATE_CONTENT_TEST_BOARD: () => records.createContentTestBoard(creator),
      CREATE_INTERNAL_TASKS: () => records.createInternalTasks(creator),
      REQUEST_SOCIAL_INTEGRATIONS: () => records.requestSocialIntegrations(creator),
      REQUEST_REVENUE_INTEGRATION: () => records.requestRevenueIntegration(creator),
      CREATE_BASELINE_REQUEST: () => records.createBaselineRequest(creator),
      SCHEDULE_DAILY_REPORT: () => records.scheduleDailyReport(creator),
      SCHEDULE_WEEKLY_REVIEW: () => records.scheduleWeeklyReview(creator),
      GENERATE_WELCOME_PACKAGE: () => records.generateWelcomePackage(creator),
      MARK_PROVISIONING_COMPLETE: () => records.markProvisioningComplete(creator),
      COMPLETE_ACTIVATION: () => records.completeActivation(creator),
    };
    const recorder = recorders[name];
    if (recorder) {
      await recorder();
      return null;
    }

    // LOCK_IDEMPOTENCY and AWAIT_BASELINE_READINESS are genuinely control-flow
    // only: the first is satisfied by the database's one-active-run index, the
    // second is the gate handled in advance(). They are the only two steps that
    // legitimately do no work.
    return null;
  }
}
