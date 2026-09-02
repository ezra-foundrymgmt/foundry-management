import { Inngest } from "inngest";
import { reports } from "@creatoros/domain";
import { createLiveOnboardingService, loadLiveOnboardingCreator } from "@/lib/live-onboarding";

export const inngest = new Inngest({ id: "creatoros" });

export const generateDailyCreatorReport = inngest.createFunction(
  {
    id: "creator-daily-report-generate",
    retries: 3,
    triggers: [{ event: "creator.daily-report.requested" }],
  },
  async ({ event, step }) => {
    const creatorId = String(event.data["creatorId"] ?? "");
    const report = await step.run(
      "run-rules-diagnostic",
      () => reports.find((item) => item.creatorId === creatorId) ?? null,
    );
    if (!report) throw new Error("CREATOR_REPORT_INPUT_NOT_FOUND");
    await step.sendEvent("emit-report-generated", {
      name: "creator.report.generated",
      data: { creatorId, reportId: report.id, provider: "RULES" },
    });
    return { reportId: report.id, creatorId, status: "READY" };
  },
);

export const activateCreator = inngest.createFunction(
  {
    id: "creator-activation-v1",
    retries: 4,
    idempotency: "event.data.idempotencyKey",
    triggers: [{ event: "creator.activation.requested" }],
  },
  async ({ event, step }) => {
    const organizationId = String(event.data["organizationId"] ?? "");
    const creatorId = String(event.data["creatorId"] ?? "");
    const actorUserId = String(event.data["actorUserId"] ?? "");
    if (!organizationId || !creatorId || !actorUserId) throw new Error("INVALID_ACTIVATION_EVENT");
    const creator = await step.run("load-creator-and-prerequisites", () =>
      loadLiveOnboardingCreator(organizationId, creatorId),
    );
    if (!creator) throw new Error("CREATOR_NOT_FOUND");
    const run = await step.run("execute-deterministic-activation", async () => {
      const { repository, service } = await createLiveOnboardingService(
        organizationId,
        actorUserId,
        creatorId,
      );
      const existing = await repository.findActiveRun(creatorId);
      return existing ? service.resume(existing, creator) : service.start(creator);
    });
    if (run.status === "FAILED") throw new Error("CREATOR_ACTIVATION_STEP_FAILED");
    return { workflowRunId: run.id, status: run.status, correlationId: run.correlationId };
  },
);
