import { describe, expect, it } from "vitest";
import {
  MockFileStorageProvider,
  MockNotionProvider,
  MockSlackProvider,
  type NotionProvider,
  type SlackProvider,
} from "@creatoros/integrations";
import {
  ACTIVATION_STEPS,
  MemoryOnboardingRepository,
  OnboardingService,
  type OnboardingCreator,
} from "./index";

/**
 * Failure drills for CREATOR_ACTIVATION_V1, run against the deterministic mock
 * providers. These are FIXTURE VERIFIED: they prove the orchestration behaves
 * correctly when a provider fails, when the process restarts, and when two
 * operators race. They do not prove anything about live Slack or Notion.
 */

const madison: OnboardingCreator = {
  id: "20000000-0000-4000-8000-000000000001",
  creatorNumber: "CR-000001",
  stageName: "Madison Carter",
  stageSlug: "madison-carter",
  status: "ONBOARDING",
  contractSigned: true,
  adultConfirmed: true,
  jurisdictionApproved: true,
  contactEmail: "madison@fictional.demo",
  timezone: "America/Los_Angeles",
  assignedTeam: true,
  boundariesCollected: true,
  baselineReady: false,
};

class CountingSlack extends MockSlackProvider {
  calls = 0;
  override createChannel(input: Parameters<MockSlackProvider["createChannel"]>[0]) {
    this.calls += 1;
    return super.createChannel(input);
  }
}

class ScriptedNotion implements NotionProvider {
  hubCalls = 0;
  internalCalls = 0;
  #delegate: NotionProvider = new MockNotionProvider();
  constructor(private failHubUntilAttempt = 0) {}
  createCreatorHub(input: Parameters<NotionProvider["createCreatorHub"]>[0]) {
    this.hubCalls += 1;
    if (this.hubCalls <= this.failHubUntilAttempt)
      return Promise.reject(new Error("NOTION_TEMPORARY_FAILURE"));
    return this.#delegate.createCreatorHub(input);
  }
  createInternalResources(input: Parameters<NotionProvider["createInternalResources"]>[0]) {
    this.internalCalls += 1;
    return this.#delegate.createInternalResources(input);
  }
  updateCreatorHub(resourceId: string, fields: Readonly<Record<string, unknown>>) {
    return this.#delegate.updateCreatorHub(resourceId, fields);
  }
  archiveCreatorHub(resourceId: string) {
    return this.#delegate.archiveCreatorHub(resourceId);
  }
}

function build(
  slack: SlackProvider,
  notion: NotionProvider,
  repository = new MemoryOnboardingRepository(),
) {
  return {
    repository,
    service: new OnboardingService(repository, {
      slack,
      notion,
      files: new MockFileStorageProvider(),
    }),
  };
}

const externalIdsFor = (run: { steps: Array<{ name: string; externalId: string | null }> }) =>
  Object.fromEntries(
    run.steps.filter((step) => step.externalId).map((step) => [step.name, step.externalId]),
  );

describe("Drill A — Slack succeeds, Notion fails", () => {
  it("records the failure, keeps Slack ids, and retries only Notion", async () => {
    const slack = new CountingSlack();
    const notion = new ScriptedNotion(1);
    const { service } = build(slack, notion);

    const failed = await service.start(madison);
    expect(failed.status).toBe("FAILED");
    expect(failed.steps.find((step) => step.name === "PROVISION_NOTION_HUB")?.error).toBe(
      "NOTION_TEMPORARY_FAILURE",
    );

    // Both Slack channels were provisioned and their external ids persisted.
    const slackIds = externalIdsFor(failed);
    expect(slackIds["PROVISION_SLACK_CREATOR"]).toBeTruthy();
    expect(slackIds["PROVISION_SLACK_INTERNAL"]).toBeTruthy();
    expect(slack.calls).toBe(2);

    const resumed = await service.resume(failed, madison);

    // Retry must not create a third and fourth Slack channel.
    expect(slack.calls).toBe(2);
    expect(externalIdsFor(resumed)["PROVISION_SLACK_CREATOR"]).toBe(
      slackIds["PROVISION_SLACK_CREATOR"],
    );
    expect(externalIdsFor(resumed)["PROVISION_SLACK_INTERNAL"]).toBe(
      slackIds["PROVISION_SLACK_INTERNAL"],
    );
    // Notion was retried exactly once more and then succeeded.
    expect(notion.hubCalls).toBe(2);
    expect(resumed.steps.find((step) => step.name === "PROVISION_NOTION_HUB")?.status).toBe(
      "SUCCEEDED",
    );
    expect(resumed.status).toBe("WAITING_EXTERNAL");
  });

  it("counts the failed attempt rather than silently resetting it", async () => {
    const notion = new ScriptedNotion(1);
    const { service } = build(new CountingSlack(), notion);
    const failed = await service.start(madison);
    const resumed = await service.resume(failed, madison);
    expect(resumed.steps.find((step) => step.name === "PROVISION_NOTION_HUB")?.attempts).toBe(2);
  });
});

describe("Drill B — Notion succeeds, then the process restarts", () => {
  it("does not create a second hub page after a restart", async () => {
    const slack = new CountingSlack();
    const notion = new ScriptedNotion();
    const repository = new MemoryOnboardingRepository();
    const first = build(slack, notion, repository);

    const waiting = await first.service.start(madison);
    expect(waiting.status).toBe("WAITING_EXTERNAL");
    expect(notion.hubCalls).toBe(1);
    const hubId = externalIdsFor(waiting)["PROVISION_NOTION_HUB"];
    expect(hubId).toBeTruthy();

    // Restart: a new service and new provider adapters over the persisted
    // repository, which is what survives a redeploy.
    const restarted = build(new CountingSlack(), notion, repository);
    const active = await restarted.repository.findActiveRun(madison.id);
    expect(active).not.toBeNull();
    const resumed = await restarted.service.resume(active!, { ...madison, baselineReady: true });

    expect(resumed.status).toBe("SUCCEEDED");
    // The provisioning claim is what prevents a duplicate, so Notion is never
    // called a second time for the same resource.
    expect(notion.hubCalls).toBe(1);
    expect(externalIdsFor(resumed)["PROVISION_NOTION_HUB"]).toBe(hubId);
  });
});

describe("Drill C — baseline data never arrives", () => {
  it("parks in an explicit waiting state and keeps unknown unknown", async () => {
    const { service } = build(new CountingSlack(), new ScriptedNotion());
    let run = await service.start(madison);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(run.status).toBe("WAITING_EXTERNAL");
      expect(run.steps.find((step) => step.name === "AWAIT_BASELINE_READINESS")?.status).toBe(
        "WAITING_EXTERNAL",
      );
      // Activation is never reported complete while the baseline is missing.
      expect(run.steps.find((step) => step.name === "COMPLETE_ACTIVATION")?.status).toBe("PENDING");
      run = await service.resume(run, madison);
    }
    expect(run.status).toBe("WAITING_EXTERNAL");
  });

  it("completes only once the baseline is genuinely present", async () => {
    const { service } = build(new CountingSlack(), new ScriptedNotion());
    const waiting = await service.start(madison);
    const completed = await service.resume(waiting, { ...madison, baselineReady: true });
    expect(completed.status).toBe("SUCCEEDED");
    expect(completed.steps.every((step) => step.status === "SUCCEEDED")).toBe(true);
    expect(completed.steps).toHaveLength(ACTIVATION_STEPS.length);
  });
});

describe("Drill D — two operators start onboarding at once", () => {
  it("produces exactly one active run and one set of external resources", async () => {
    const slack = new CountingSlack();
    const notion = new ScriptedNotion();
    const { repository, service } = build(slack, notion);

    const [first, second, third] = await Promise.all([
      service.start(madison),
      service.start(madison),
      service.start(madison),
    ]);

    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(await repository.countRuns(madison.id)).toBe(1);
    // Two Slack channels total, not two per concurrent request.
    expect(slack.calls).toBe(2);
    expect(notion.hubCalls).toBe(1);
    expect(notion.internalCalls).toBe(1);
  });
});

describe("Drill G — prerequisites missing", () => {
  it("blocks before provisioning anything external", async () => {
    const slack = new CountingSlack();
    const notion = new ScriptedNotion();
    const { service } = build(slack, notion);
    const blocked = await service.start({
      ...madison,
      id: "40000000-0000-4000-8000-000000000009",
      contractSigned: false,
      boundariesCollected: false,
    });
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.blockers).toContain("Signed contract required");
    expect(blocked.blockers).toContain("Creator boundaries collection required");
    // Nothing was created in Slack or Notion for a creator who is not cleared.
    expect(slack.calls).toBe(0);
    expect(notion.hubCalls).toBe(0);
    expect(blocked.steps.every((step) => step.status === "PENDING")).toBe(true);
  });
});
