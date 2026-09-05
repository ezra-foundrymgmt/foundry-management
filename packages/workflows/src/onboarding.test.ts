import { describe, expect, it } from "vitest";
import {
  MockFileStorageProvider,
  MockNotionProvider,
  MockSlackProvider,
  type NotionProvider,
  type ProvisionedResource,
} from "@creatoros/integrations";
import {
  MemoryActivationRecordPort,
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
  teamSlackUserIds: ["U_EZRA", "U_PAYTON"],
  boundariesCollected: true,
  intakeApplied: true,
  baselineReady: false,
};

function setup() {
  const repository = new MemoryOnboardingRepository();
  const slack = new MockSlackProvider();
  const service = new OnboardingService(repository, {
    slack,
    notion: new MockNotionProvider(),
    files: new MockFileStorageProvider(),
  });
  return { repository, service, slack };
}

describe("CREATOR_ACTIVATION_V1", () => {
  it("executes all deterministic provisioning then waits for baseline", async () => {
    const { service } = setup();
    const run = await service.start(madison);
    expect(run.status).toBe("WAITING_EXTERNAL");
    expect(run.steps).toHaveLength(26);
    expect(run.steps.find((step) => step.name === "PROVISION_SLACK_INTERNAL")?.provider).toBe(
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
      (step) => step.name === "PROVISION_SLACK_INTERNAL",
    )?.attempts;
    const completed = await service.resume(waiting, { ...madison, baselineReady: true });
    expect(completed.status).toBe("SUCCEEDED");
    expect(completed.steps.find((step) => step.name === "PROVISION_SLACK_INTERNAL")?.attempts).toBe(
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
    expect(slack.attempts).toBe(1);
    // One channel, not two: there is no creator channel on a free workspace.
    // Advancing a completed run is a no-op, not a second round of provisioning.
    run = await service.advance(run, { ...madison, baselineReady: true });
    expect(run.status).toBe("SUCCEEDED");
    expect(slack.attempts).toBe(1);
  });

  it("actually performs the CreatorOS bookkeeping steps rather than marking them done", async () => {
    // Regression: 21 of the 26 steps returned null and were marked SUCCEEDED
    // without touching anything, so a completed activation did not imply a brand
    // profile, a P&L period, internal tasks or a report schedule existed.
    const records = new MemoryActivationRecordPort();
    const service = new OnboardingService(new MemoryOnboardingRepository(), {
      slack: new MockSlackProvider(),
      notion: new MockNotionProvider(),
      files: new MockFileStorageProvider(),
      records,
    });
    const run = await service.start({ ...madison, baselineReady: true });
    expect(run.status).toBe("SUCCEEDED");

    expect(records.calls).toEqual([
      "validateCreator",
      "recordActivationStarted",
      "assignTeam",
      "initializeBrandProfile",
      "initializeHealth",
      "initializePnl",
      "initializeContentInventory",
      "createCompetitorResearch",
      "createContentTestBoard",
      "createInternalTasks",
      "requestSocialIntegrations",
      "requestRevenueIntegration",
      "createBaselineRequest",
      "scheduleDailyReport",
      "scheduleWeeklyReview",
      "generateWelcomePackage",
      "markProvisioningComplete",
      "completeActivation",
    ]);
  });

  it("posts the welcome message into the channel it actually provisioned", async () => {
    const posts: Array<{ channel: string; message: string }> = [];
    class RecordingSlack extends MockSlackProvider {
      override postMessage(...args: unknown[]) {
        posts.push({ channel: String(args[0]), message: String(args[1]) });
        return Promise.resolve();
      }
    }
    const slack = new RecordingSlack();
    const service = new OnboardingService(new MemoryOnboardingRepository(), {
      slack,
      notion: new MockNotionProvider(),
      files: new MockFileStorageProvider(),
    });
    const run = await service.start({ ...madison, baselineReady: true });
    const internalChannel = run.steps.find(
      (step) => step.name === "PROVISION_SLACK_INTERNAL",
    )?.externalId;
    expect(posts).toHaveLength(1);
    // Read from the persisted run, so it cannot post into a channel that was
    // never provisioned. It is addressed to the team, not to the creator, and
    // says so -- she is not in Slack at all.
    expect(posts[0]?.channel).toBe(internalChannel);
    expect(posts[0]?.message).toContain("Madison Carter");
    expect(posts[0]?.message).toMatch(/send it to her yourself/i);
    expect(posts[0]?.message).toMatch(/not in Slack/i);
  });

  it("does not repeat completed bookkeeping when a run is resumed", async () => {
    const records = new MemoryActivationRecordPort();
    const service = new OnboardingService(new MemoryOnboardingRepository(), {
      slack: new MockSlackProvider(),
      notion: new MockNotionProvider(),
      files: new MockFileStorageProvider(),
      records,
    });
    const waiting = await service.start(madison);
    const callsBefore = [...records.calls];
    expect(callsBefore).toContain("initializeBrandProfile");
    expect(callsBefore).not.toContain("completeActivation");

    const completed = await service.resume(waiting, { ...madison, baselineReady: true });
    expect(completed.status).toBe("SUCCEEDED");
    // The resume adds only the remaining step; nothing already done runs twice.
    expect(records.calls.filter((call) => call === "initializeBrandProfile")).toHaveLength(1);
    expect(records.calls).toContain("completeActivation");
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

  it("re-evaluates a BLOCKED run's prerequisites on the next start instead of freezing it forever", async () => {
    // Regression: #createRunLocked returned an existing BLOCKED run unchanged,
    // so a creator blocked once could never activate even after the missing
    // prerequisite was fixed -- the one-active-run-per-creator constraint made
    // a fresh run impossible, and nothing re-checked whether blockers still
    // held. Hit live this session; required a manual SQL fix to unstick.
    const { service } = setup();
    const blocked = await service.start({
      ...madison,
      id: "blocked-then-fixed",
      contractSigned: false,
      contactEmail: null,
    });
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.blockers).toEqual([
      "Signed contract required",
      "Creator contact email required",
    ]);

    const resumed = await service.start({
      ...madison,
      id: "blocked-then-fixed",
      contractSigned: true,
      contactEmail: "blocked-then-fixed@example.test",
    });
    expect(resumed.id).toBe(blocked.id);
    expect(resumed.status).toBe("WAITING_EXTERNAL");
    expect(resumed.blockers).toEqual([]);
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
    expect(slack.attempts).toBe(1);

    const resumed = await service.resume(failed, madison);
    expect(resumed.status).toBe("WAITING_EXTERNAL");
    expect(slack.attempts).toBe(1);
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

/**
 * Both Slack channels were created correctly and then left empty: inviteMembers
 * and setTopic were implemented on the provider and called by nothing, so
 * activation finished with two private channels containing only the bot, and
 * the welcome message posted to an audience of nobody.
 */
describe("creator Slack channels get the right people in them", () => {
  function channelIdFor(run: Awaited<ReturnType<OnboardingService["start"]>>, step: string) {
    return run.steps.find((s) => s.name === step)?.externalId ?? "";
  }

  it("puts the Foundry team in the internal channel", async () => {
    const { service, slack } = setup();
    const run = await service.start(madison);
    const channel = channelIdFor(run, "PROVISION_SLACK_INTERNAL");
    expect(channel).not.toBe("");
    expect(slack.invited.get(channel)).toEqual(["U_EZRA", "U_PAYTON"]);
  });

  it("creates exactly one channel, and it is the internal one", async () => {
    const { service } = setup();
    const run = await service.start(madison);
    const slackSteps = run.steps.filter((step) => step.provider === "SLACK");
    expect(slackSteps.map((step) => step.name)).toEqual(["PROVISION_SLACK_INTERNAL"]);
  });

  /**
   * The rule that used to be "never the internal channel" is now simply "never".
   *
   * A free Slack workspace cannot originate a Slack Connect invitation, and
   * adding a creator as a full member would let her browse the People directory
   * and see every other creator Foundry manages. So no channel this workflow
   * creates may ever carry an external invite — asserted across every channel
   * rather than by name, so a future channel cannot quietly opt out of it.
   */
  it("never invites the creator to any channel", async () => {
    const { service, slack } = setup();
    const run = await service.start(madison);
    for (const step of run.steps.filter((candidate) => candidate.provider === "SLACK"))
      expect(slack.externalInvites.get(step.externalId ?? ""), step.name).toBeUndefined();
    expect([...slack.externalInvites.keys()]).toEqual([]);
  });

  it("still provisions when nobody has linked a Slack identity yet", async () => {
    // An empty roster is a real state on a new workspace. It must leave the
    // channel empty rather than failing the whole activation.
    const { service, slack } = setup();
    const run = await service.start({ ...madison, teamSlackUserIds: [] });
    expect(run.steps.find((s) => s.name === "PROVISION_SLACK_INTERNAL")?.status).toBe("SUCCEEDED");
    expect(slack.invited.get(channelIdFor(run, "PROVISION_SLACK_INTERNAL"))).toEqual([]);
  });

  it("says in the channel topic that the creator cannot read it", async () => {
    // With no creator channel, this sentence is the only thing telling a reader
    // that what they write here is not visible to the person it is about.
    const { service, slack } = setup();
    const run = await service.start(madison);
    const topic = slack.topics.get(channelIdFor(run, "PROVISION_SLACK_INTERNAL"));
    expect(topic).toContain("Madison Carter");
    expect(topic).toMatch(/not in this channel/i);
  });
});

/**
 * AWAIT_INTAKE parks the run until a creator's Model Information Sheet has been
 * reviewed and applied, and it is placed before the welcome package because the
 * package quotes her boundaries back to her.
 */
describe("AWAIT_INTAKE", () => {
  it("parks before the welcome package when no intake has been applied", async () => {
    const { service } = setup();
    const run = await service.start({ ...madison, intakeApplied: false, baselineReady: true });

    expect(run.status).toBe("WAITING_EXTERNAL");
    expect(run.steps.find((step) => step.name === "AWAIT_INTAKE")?.status).toBe("WAITING_EXTERNAL");
    // The package must not have been composed yet: composed now, it would tell
    // her Foundry has recorded nothing about what she will not do.
    expect(run.steps.find((step) => step.name === "GENERATE_WELCOME_PACKAGE")?.status).toBe(
      "PENDING",
    );
  });

  it("proceeds once the intake is applied", async () => {
    const { service } = setup();
    const waiting = await service.start({
      ...madison,
      intakeApplied: false,
      baselineReady: true,
    });
    const completed = await service.resume(waiting, { ...madison, baselineReady: true });
    expect(completed.status).toBe("SUCCEEDED");
    expect(completed.steps.find((step) => step.name === "AWAIT_INTAKE")?.status).toBe("SUCCEEDED");
  });

  /**
   * Regression shape borrowed from AWAIT_BASELINE_READINESS: a resume must
   * re-evaluate the gate rather than skip a step that is already
   * WAITING_EXTERNAL, or it walks straight past it.
   */
  it("keeps waiting when a resume arrives with the intake still unapplied", async () => {
    const { service } = setup();
    const waiting = await service.start({
      ...madison,
      intakeApplied: false,
      baselineReady: true,
    });
    const stillWaiting = await service.resume(waiting, {
      ...madison,
      intakeApplied: false,
      baselineReady: true,
    });
    expect(stillWaiting.status).toBe("WAITING_EXTERNAL");
    expect(stillWaiting.steps.find((step) => step.name === "COMPLETE_ACTIVATION")?.status).toBe(
      "PENDING",
    );
  });
});
