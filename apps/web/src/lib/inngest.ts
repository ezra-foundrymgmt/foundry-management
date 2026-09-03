import { Inngest, NonRetriableError } from "inngest";
import { z } from "zod";
import { reports } from "@creatoros/domain";
import { ACTIVATION_STEPS, type WorkflowRun } from "@creatoros/workflows";
import { createLiveOnboardingService, loadLiveOnboardingCreator } from "@/lib/live-onboarding";

export const inngest = new Inngest({ id: "creatoros" });

const activationEventSchema = z.object({
  organizationId: z.string().uuid(),
  creatorId: z.string().uuid(),
  actorUserId: z.string().min(1),
});

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
    if (!report) throw new NonRetriableError("CREATOR_REPORT_INPUT_NOT_FOUND");
    await step.sendEvent("emit-report-generated", {
      name: "creator.report.generated",
      data: { creatorId, reportId: report.id, provider: "RULES" },
    });
    return { reportId: report.id, creatorId, status: "READY" };
  },
);

/**
 * Runs one activation step and reports what happened. The whole point of
 * returning a summary rather than throwing on a business outcome is that
 * WAITING_EXTERNAL is a legitimate resting state, whereas a step error must
 * escape `step.run` so Inngest retries that single step.
 */
async function advanceOneStep(input: z.infer<typeof activationEventSchema>) {
  const creator = await loadLiveOnboardingCreator(input.organizationId, input.creatorId);
  if (!creator) throw new NonRetriableError("CREATOR_NOT_FOUND");
  const { repository, service } = await createLiveOnboardingService(
    input.organizationId,
    input.actorUserId,
    input.creatorId,
  );
  const current = await repository.findActiveRun(input.creatorId);
  if (!current) return { status: "SUCCEEDED" as const, runId: null, correlationId: null };
  const advanced = await service.advance(current, creator);
  if (advanced.status === "FAILED") {
    const failure = advanced.steps.find((step) => step.status === "FAILED");
    // Thrown from inside step.run so Inngest retries this step alone. Returning
    // a failed run instead would let Inngest memoise the failure and replay it
    // on every retry without ever re-executing the work.
    throw new Error(
      `ACTIVATION_STEP_FAILED:${failure?.name ?? "UNKNOWN"}:${failure?.error ?? "UNKNOWN"}`,
    );
  }
  return {
    status: advanced.status,
    runId: advanced.id,
    correlationId: advanced.correlationId,
  };
}

export const activateCreator = inngest.createFunction(
  {
    id: "creator-activation-v1",
    retries: 4,
    idempotency: "event.data.idempotencyKey",
    triggers: [{ event: "creator.activation.requested" }, { event: "creator.activation.resume" }],
  },
  async ({ event, step }) => {
    const parsed = activationEventSchema.safeParse(event.data);
    if (!parsed.success) throw new NonRetriableError("INVALID_ACTIVATION_EVENT");
    const input = parsed.data;

    const created: WorkflowRun = await step.run("ensure-activation-run", async () => {
      const creator = await loadLiveOnboardingCreator(input.organizationId, input.creatorId);
      if (!creator) throw new NonRetriableError("CREATOR_NOT_FOUND");
      const { service } = await createLiveOnboardingService(
        input.organizationId,
        input.actorUserId,
        input.creatorId,
      );
      return service.createRun(creator);
    });
    if (created.status === "BLOCKED")
      return { workflowRunId: created.id, status: "BLOCKED", blockers: created.blockers };

    // One checkpoint per activation step. An interrupted deploy resumes at the
    // step boundary it reached rather than replaying all 26 from the beginning.
    for (const stepName of ACTIVATION_STEPS) {
      const outcome = await step.run(`activation:${stepName}`, () => advanceOneStep(input));
      if (outcome.status === "WAITING_EXTERNAL")
        return {
          workflowRunId: outcome.runId,
          status: "WAITING_EXTERNAL",
          correlationId: outcome.correlationId,
        };
      if (outcome.status === "SUCCEEDED")
        return {
          workflowRunId: outcome.runId,
          status: "SUCCEEDED",
          correlationId: outcome.correlationId,
        };
    }
    return { workflowRunId: created.id, status: "RUNNING" };
  },
);
