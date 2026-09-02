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

export interface OnboardingProviders {
  slack: SlackProvider;
  notion: NotionProvider;
  files: FileStorageProvider;
}

export class OnboardingService {
  constructor(
    private readonly repository: OnboardingRepository,
    private readonly providers: OnboardingProviders,
  ) {}

  async start(creator: OnboardingCreator): Promise<WorkflowRun> {
    return this.repository.withCreatorLock(creator.id, async () => {
      const existing = await this.repository.findActiveRun(creator.id);
      if (existing) return existing;
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
      if (blockers.length > 0) return run;
      return this.#execute(run, creator);
    });
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

  async #execute(run: WorkflowRun, creator: OnboardingCreator): Promise<WorkflowRun> {
    run.status = "RUNNING";
    for (const step of run.steps) {
      if (step.status === "SUCCEEDED" || step.status === "WAITING_EXTERNAL") continue;
      if (step.name === "AWAIT_BASELINE_READINESS" && !creator.baselineReady) {
        step.status = "WAITING_EXTERNAL";
        step.completedAt = new Date().toISOString();
        run.status = "WAITING_EXTERNAL";
        await this.repository.saveRun(run);
        return run;
      }
      step.status = "RUNNING";
      step.startedAt = new Date().toISOString();
      step.attempts += 1;
      try {
        const resource = await this.#executeStep(step.name, creator);
        step.status = "SUCCEEDED";
        step.completedAt = new Date().toISOString();
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
        return run;
      }
    }
    run.status = "SUCCEEDED";
    run.completedAt = new Date().toISOString();
    await this.repository.saveRun(run);
    return run;
  }

  async #executeStep(
    name: ActivationStepName,
    creator: OnboardingCreator,
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
    return null;
  }
}
