import { Inngest } from "inngest";
import { reports } from "@creatoros/domain";

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
