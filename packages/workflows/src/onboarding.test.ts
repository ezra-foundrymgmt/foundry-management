import { describe, expect, it } from "vitest";
import {
  MockFileStorageProvider,
  MockNotionProvider,
  MockSlackProvider,
  type NotionProvider,
  type ProvisionedResource,
} from "@creatoros/integrations";
import {
  MemoryOnboardingRepository,
  OFFBOARDING_STEPS,
  OnboardingService,
  type OnboardingCreator,
} from "./index";

const madison: OnboardingCreator = {
  id: "madison",
  creatorNumber: "CR-000001",
  stageName: "Madison Carter",
  stageSlug: "madison",
  status: "ONBOARDING",
  contractSigned: true,
  adultConfirmed: true,
  jurisdictionApproved: true,
  contactEmail: "madison@example.test",
  timezone: "America/Los_Angeles",
  assignedTeam: true,
  boundariesCollected: true,
  baselineReady: false,
};

function setup() {
  const repository = new MemoryOnboardingRepository();
  const service = new OnboardingService(repository, {
    slack: new MockSlackProvider(),
    notion: new MockNotionProvider(),
    files: new MockFileStorageProvider(),
  });
  return { repository, service };
}

describe("CREATOR_ACTIVATION_V1", () => {
  it("executes all deterministic provisioning then waits for baseline", async () => {
    const { service } = setup();
    const run = await service.start(madison);
    expect(run.status).toBe("WAITING_EXTERNAL");
    expect(run.steps).toHaveLength(26);
    expect(run.steps.find((step) => step.name === "PROVISION_SLACK_CREATOR")?.provider).toBe(
      "SLACK",
    );
    expect(run.steps.find((step) => step.name === "AWAIT_BASELINE_READINESS")?.status).toBe(
      "WAITING_EXTERNAL",
    );
  });

  it("allows exactly one active run when onboarding is started concurrently", async () => {
    const { repository, service } = setup();
    const [first, second] = await Promise.all([service.start(madison), service.start(madison)]);
    expect(first.id).toBe(second.id);
    expect(await repository.countRuns(madison.id)).toBe(1);
  });

  it("resumes from the external baseline wait without duplicating completed steps", async () => {
    const { service } = setup();
    const waiting = await service.start(madison);
    const slackAttempts = waiting.steps.find(
      (step) => step.name === "PROVISION_SLACK_CREATOR",
    )?.attempts;
    const completed = await service.resume(waiting, { ...madison, baselineReady: true });
    expect(completed.status).toBe("SUCCEEDED");
    expect(completed.steps.find((step) => step.name === "PROVISION_SLACK_CREATOR")?.attempts).toBe(
      slackAttempts,
    );
  });

  it("keeps waiting when a resume arrives while baseline data is still missing", async () => {
    // Regression: the executor skipped any step already marked WAITING_EXTERNAL,
    // so a resume walked straight past the baseline gate and reported SUCCEEDED
    // for a creator whose baseline had never been imported. Unknown must stay
    // unknown however many times the workflow is resumed.
    const { service } = setup();
    const waiting = await service.start(madison);
    expect(waiting.status).toBe("WAITING_EXTERNAL");

    const stillWaiting = await service.resume(waiting, { ...madison, baselineReady: false });
    expect(stillWaiting.status).toBe("WAITING_EXTERNAL");
    expect(stillWaiting.steps.find((step) => step.name === "COMPLETE_ACTIVATION")?.status).toBe(
      "PENDING",
    );

    const twiceWaiting = await service.resume(stillWaiting, { ...madison, baselineReady: false });
    expect(twiceWaiting.status).toBe("WAITING_EXTERNAL");
    expect(twiceWaiting.steps.find((step) => step.name === "COMPLETE_ACTIVATION")?.status).toBe(
      "PENDING",
    );

    const completed = await service.resume(twiceWaiting, { ...madison, baselineReady: true });
    expect(completed.status).toBe("SUCCEEDED");
    expect(completed.steps.find((step) => step.name === "COMPLETE_ACTIVATION")?.status).toBe(
      "SUCCEEDED",
    );
  });

  it("advances exactly one step per call so a durable executor can checkpoint", async () => {
    const { service, repository } = setup();
    let run = await repository.findActiveRun(madison.id);
    expect(run).toBeNull();

    // start() would run to completion; drive the same machine one step at a time.
    const started = await service.start({ ...madison, baselineReady: true });
    expect(started.status).toBe("SUCCEEDED");

    const fresh = setup();
    let stepwise = await fresh.service.start({ ...madison, id: "stepwise", baselineReady: false });
    expect(stepwise.status).toBe("WAITING_EXTERNAL");
    const succeededBefore = stepwise.steps.filter((step) => step.status === "SUCCEEDED").length;
    stepwise = await fresh.service.advance(stepwise, {
      ...madison,
      id: "stepwise",
      baselineReady: true,
    });
    expect(stepwise.steps.filter((step) => step.status === "SUCCEEDED").length).toBe(
      succeededBefore + 1,
    );
    run = stepwise;
    expect(run.status).toBe("RUNNING");
  });

  it("does not re-run a provisioning step that already succeeded when advancing", async () => {
    class CountingSlackProvider extends MockSlackProvider {
      attempts = 0;
      override createChannel(input: Parameters<MockSlackProvider["createChannel"]>[0]) {
        this.attempts += 1;
        return super.createChannel(input);
      }
    }
    const slack = new CountingSlackProvider();
    const service = new OnboardingService(new MemoryOnboardingRepository(), {
      slack,
      notion: new MockNotionProvider(),
      files: new MockFileStorageProvider(),
    });
    let run = await service.start({ ...madison, baselineReady: true });
    expect(run.status).toBe("SUCCEEDED");
    expect(slack.attempts).toBe(2);
    // Advancing a completed run is a no-op, not a second round of provisioning.
    run = await service.advance(run, { ...madison, baselineReady: true });
    expect(run.status).toBe("SUCCEEDED");
    expect(slack.attempts).toBe(2);
  });

  it("blocks before partial provisioning when prerequisites are missing", async () => {
    const { service } = setup();
    const blocked = await service.start({
      ...madison,
      id: "blocked",
      contractSigned: false,
      contactEmail: null,
    });
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.blockers).toEqual([
      "Signed contract required",
      "Creator contact email required",
    ]);
    expect(blocked.steps.every((step) => step.status === "PENDING")).toBe(true);
  });

  it("resumes after a provider failure without repeating completed provisioning", async () => {
    class CountingSlackProvider extends MockSlackProvider {
      attempts = 0;
      override createChannel(input: Parameters<MockSlackProvider["createChannel"]>[0]) {
        this.attempts += 1;
        return super.createChannel(input);
      }
    }
    class FlakyNotionProvider implements NotionProvider {
      readonly delegate: NotionProvider = new MockNotionProvider();
      hubAttempts = 0;
      createCreatorHub(
        input: Parameters<NotionProvider["createCreatorHub"]>[0],
      ): Promise<ProvisionedResource> {
        this.hubAttempts += 1;
        if (this.hubAttempts === 1) return Promise.reject(new Error("NOTION_TEMPORARY_FAILURE"));
        return this.delegate.createCreatorHub(input);
      }
      createInternalResources(input: Parameters<NotionProvider["createInternalResources"]>[0]) {
        return this.delegate.createInternalResources(input);
      }
      updateCreatorHub(resourceId: string, fields: Readonly<Record<string, unknown>>) {
        return this.delegate.updateCreatorHub(resourceId, fields);
      }
      archiveCreatorHub(resourceId: string) {
        return this.delegate.archiveCreatorHub(resourceId);
      }
    }

    const slack = new CountingSlackProvider();
    const notion = new FlakyNotionProvider();
    const service = new OnboardingService(new MemoryOnboardingRepository(), {
      slack,
      notion,
      files: new MockFileStorageProvider(),
    });
    const failed = await service.start(madison);
    expect(failed.status).toBe("FAILED");
    expect(failed.steps.find((step) => step.name === "PROVISION_NOTION_HUB")?.error).toBe(
      "NOTION_TEMPORARY_FAILURE",
    );
    expect(slack.attempts).toBe(2);

    const resumed = await service.resume(failed, madison);
    expect(resumed.status).toBe("WAITING_EXTERNAL");
    expect(slack.attempts).toBe(2);
    expect(notion.hubAttempts).toBe(2);
  });
});

describe("CREATOR_OFFBOARDING_V1", () => {
  it("defines a conservative manual-first offboarding sequence", () => {
    expect(OFFBOARDING_STEPS).toEqual([
      "VALIDATE_OFFBOARDING_APPROVAL",
      "REVOKE_FOUNDRY_ACCESS",
      "DISCONNECT_INTEGRATIONS",
      "PREPARE_PERMITTED_DATA_EXPORT",
      "ARCHIVE_OPEN_TASKS",
      "ARCHIVE_NOTION_PROJECTIONS",
      "ARCHIVE_SLACK_CHANNELS",
      "REQUEST_FINAL_FINANCIAL_RECONCILIATION",
      "MARK_CREATOR_FORMER",
    ]);
  });
});
