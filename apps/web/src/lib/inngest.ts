import { Inngest, NonRetriableError } from "inngest";
import { z } from "zod";
import { ACTIVATION_STEPS, type WorkflowRun } from "@creatoros/workflows";
import { createLiveOnboardingService, loadLiveOnboardingCreator } from "@/lib/live-onboarding";
import { produceDailyCreatorReport } from "@/lib/daily-report";
import { runDueReportSchedules } from "@/lib/report-scheduler";
import { logEvent } from "@/lib/observability";

export const inngest = new Inngest({ id: "creatoros" });

const reportEventSchema = z.object({
  organizationId: z.string().uuid(),
  creatorId: z.string().uuid(),
  reportDate: z.string().optional(),
});

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
    const parsed = reportEventSchema.safeParse(event.data);
    if (!parsed.success) throw new NonRetriableError("INVALID_REPORT_EVENT");
    const { organizationId, creatorId, reportDate } = parsed.data;

    // Reads real metrics and the creator's own frozen baseline. It refuses to
    // produce a report when there is no baseline or no data rather than
    // emitting one whose every comparison would be invented.
    const outcome = await step.run("run-rules-diagnostic", () =>
      produceDailyCreatorReport({
        organizationId,
        creatorId,
        ...(reportDate ? { reportDate } : {}),
      }),
    );

    if (!outcome.produced) {
      logEvent("info", "creator.daily_report.skipped", {
        organizationId,
        creatorId,
        reason: outcome.reason,
      });
      return { creatorId, status: "SKIPPED", reason: outcome.reason };
    }

    await step.sendEvent("emit-report-generated", {
      name: "creator.report.generated",
      data: { organizationId, creatorId, reportId: outcome.reportId, provider: "RULES" },
    });
    return {
      reportId: outcome.reportId,
      creatorId,
      reportDate: outcome.reportDate,
      ruleId: outcome.ruleId,
      status: "READY",
    };
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
    // The in-process creator lock is a no-op in the Supabase repository, so this
    // is what actually serialises execution: two invocations advancing the same
    // run would both read the same step as pending and provision it twice.
    concurrency: { key: "event.data.creatorId", limit: 1 },
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

    // One checkpoint per activation step, plus one. Completing the 26th step
    // leaves the run RUNNING; it is the following advance that finds nothing
    // left and marks it SUCCEEDED, so a straight-through activation needs 27
    // passes to finish.
    const passes = [...ACTIVATION_STEPS, "FINALIZE" as const];
    for (const stepName of passes) {
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

/**
 * Drives the report schedules activation creates.
 *
 * Hourly rather than daily so a schedule in any timezone becomes due within an
 * hour of its local time, and so a missed hour is picked up on the next tick
 * instead of waiting a full day. Claiming is atomic in SQL, so an overlapping
 * run picks up nothing rather than producing a second report.
 *
 * There is deliberately only one scheduler. Adding a second (a Vercel cron, say)
 * would create a competing source of truth for when a report is due.
 */
export const runReportSchedules = inngest.createFunction(
  {
    id: "creator-report-scheduler",
    retries: 2,
    // One scheduler pass at a time across the whole deployment.
    concurrency: { limit: 1 },
    triggers: [{ cron: "0 * * * *" }],
  },
  async ({ step }) => {
    const result = await step.run("run-due-schedules", () => runDueReportSchedules());
    const produced = result.outcomes.filter((outcome) => outcome.status === "PRODUCED").length;
    const skipped = result.outcomes.filter((outcome) => outcome.status === "SKIPPED").length;
    const failed = result.outcomes.filter((outcome) => outcome.status === "FAILED");

    logEvent(failed.length ? "warn" : "info", "report_scheduler.completed", {
      claimed: result.claimed,
      produced,
      skipped,
      failed: failed.length,
    });
    // Surfaced individually so an operator can see which schedule broke rather
    // than only a count.
    for (const outcome of failed)
      logEvent("error", "report_scheduler.schedule_failed", {
        scheduleId: outcome.scheduleId,
        creatorId: outcome.creatorId,
        reason: outcome.reason,
      });

    return { claimed: result.claimed, produced, skipped, failed: failed.length };
  },
);
