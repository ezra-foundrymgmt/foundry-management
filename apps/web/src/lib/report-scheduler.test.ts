import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Report schedules were inert: activation created the rows and nothing ever ran
 * them. These cover the properties that make a scheduler trustworthy — it runs
 * only what is due, it refuses rather than invents, one broken schedule does not
 * take the rest of the run down, and the date it reports on is the creator's,
 * not the server's.
 */
interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

const rpcCalls: RpcCall[] = [];
let dueSchedules: unknown[] = [];
let claimError: { message: string } | null = null;

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === "claim_due_report_schedules")
        return Promise.resolve({ data: claimError ? null : dueSchedules, error: claimError });
      return Promise.resolve({ data: null, error: null });
    },
  }),
}));

interface ReportRequest {
  organizationId: string;
  creatorId: string;
  reportDate?: string;
}

const produceDailyCreatorReport = vi.fn<(input: ReportRequest) => Promise<unknown>>();
vi.mock("@/lib/daily-report", () => ({
  produceDailyCreatorReport: (input: ReportRequest) => produceDailyCreatorReport(input),
}));

const { runDueReportSchedules, reportDateFor } = await import("./report-scheduler");

const ORG = "11111111-1111-4111-8111-111111111111";
const CREATOR_A = "22222222-2222-4222-8222-222222222222";
const CREATOR_B = "33333333-3333-4333-8333-333333333333";
const SCHEDULE_A = "44444444-4444-4444-8444-444444444444";
const SCHEDULE_B = "55555555-5555-4555-8555-555555555555";

function schedule(id: string, creatorId: string, timezone: string | null = "UTC") {
  return {
    id,
    organization_id: ORG,
    creator_id: creatorId,
    cadence: "DAILY",
    timezone,
  };
}

function resultsFor(fn: string) {
  return rpcCalls.filter((call) => call.fn === fn);
}

beforeEach(() => {
  rpcCalls.length = 0;
  dueSchedules = [];
  claimError = null;
  produceDailyCreatorReport.mockReset();
  produceDailyCreatorReport.mockResolvedValue({
    produced: true,
    reportId: "report-1",
    reportDate: "2026-09-02",
    ruleId: "RULE",
  });
});

describe("report scheduler", () => {
  it("runs nothing when nothing is due", async () => {
    const outcome = await runDueReportSchedules({ now: new Date("2026-09-02T09:00:00Z") });

    expect(outcome.claimed).toBe(0);
    expect(outcome.outcomes).toEqual([]);
    // The dangerous failure mode is a scheduler that reports on every creator
    // every hour because it never checked what was actually due.
    expect(produceDailyCreatorReport).not.toHaveBeenCalled();
    expect(resultsFor("record_report_schedule_result")).toHaveLength(0);
  });

  it("produces a report for each claimed schedule and records the outcome", async () => {
    dueSchedules = [schedule(SCHEDULE_A, CREATOR_A), schedule(SCHEDULE_B, CREATOR_B)];

    const outcome = await runDueReportSchedules({ now: new Date("2026-09-02T09:00:00Z") });

    expect(outcome.claimed).toBe(2);
    expect(outcome.outcomes.map((entry) => entry.status)).toEqual(["PRODUCED", "PRODUCED"]);
    expect(produceDailyCreatorReport).toHaveBeenCalledTimes(2);
    expect(
      resultsFor("record_report_schedule_result").map((call) => call.args["p_status"]),
    ).toEqual(["PRODUCED", "PRODUCED"]);
  });

  it("passes the claim through the SQL function that advances next_due_at atomically", async () => {
    await runDueReportSchedules({ now: new Date("2026-09-02T09:00:00Z"), limit: 7 });

    // Claiming in application code (read, then write) would let two overlapping
    // invocations claim the same schedule and report twice.
    expect(resultsFor("claim_due_report_schedules")).toEqual([
      {
        fn: "claim_due_report_schedules",
        args: { p_now: "2026-09-02T09:00:00.000Z", p_limit: 7 },
      },
    ]);
  });

  it("records a skip without producing anything when the creator has no frozen baseline", async () => {
    dueSchedules = [schedule(SCHEDULE_A, CREATOR_A)];
    produceDailyCreatorReport.mockResolvedValue({ produced: false, reason: "NO_BASELINE_FROZEN" });

    const outcome = await runDueReportSchedules({ now: new Date("2026-09-02T09:00:00Z") });

    expect(outcome.outcomes[0]).toMatchObject({
      status: "SKIPPED",
      reason: "NO_BASELINE_FROZEN",
    });
    const recorded = resultsFor("record_report_schedule_result")[0];
    expect(recorded?.args).toMatchObject({ p_status: "SKIPPED", p_error: "NO_BASELINE_FROZEN" });
  });

  it("keeps running the remaining schedules when one throws", async () => {
    dueSchedules = [schedule(SCHEDULE_A, CREATOR_A), schedule(SCHEDULE_B, CREATOR_B)];
    produceDailyCreatorReport
      .mockRejectedValueOnce(new Error("METRICS_READ_FAILED: connection reset"))
      .mockResolvedValueOnce({
        produced: true,
        reportId: "report-2",
        reportDate: "2026-09-02",
        ruleId: "RULE",
      });

    const outcome = await runDueReportSchedules({ now: new Date("2026-09-02T09:00:00Z") });

    expect(outcome.outcomes.map((entry) => entry.status)).toEqual(["FAILED", "PRODUCED"]);
    expect(outcome.outcomes[0]?.reason).toContain("METRICS_READ_FAILED");
    // The failure is persisted, which is what drives the retry backoff.
    expect(
      resultsFor("record_report_schedule_result").map((call) => call.args["p_status"]),
    ).toEqual(["FAILED", "PRODUCED"]);
  });

  it("reports on the creator's calendar date, not the server's", async () => {
    // 09:00 UTC is still the previous day in Los Angeles and already the next
    // day in Auckland. A UTC-only scheduler would report on the wrong day for
    // both of them.
    dueSchedules = [
      schedule(SCHEDULE_A, CREATOR_A, "America/Los_Angeles"),
      schedule(SCHEDULE_B, CREATOR_B, "Pacific/Auckland"),
    ];

    await runDueReportSchedules({ now: new Date("2026-09-02T09:00:00Z") });

    expect(produceDailyCreatorReport.mock.calls.map((call) => call[0].reportDate)).toEqual([
      "2026-09-02",
      "2026-09-02",
    ]);

    produceDailyCreatorReport.mockClear();
    await runDueReportSchedules({ now: new Date("2026-09-02T22:00:00Z") });

    expect(produceDailyCreatorReport.mock.calls.map((call) => call[0].reportDate)).toEqual([
      "2026-09-02",
      "2026-09-03",
    ]);
  });

  it("fails loudly when the claim itself fails", async () => {
    claimError = { message: "permission denied" };

    // Returning "0 schedules ran" here would read as a quiet night rather than
    // a broken scheduler.
    await expect(runDueReportSchedules({ now: new Date("2026-09-02T09:00:00Z") })).rejects.toThrow(
      /SCHEDULE_CLAIM_FAILED/,
    );
  });

  it("rejects a claim row that does not match the expected shape", async () => {
    dueSchedules = [{ ...schedule(SCHEDULE_A, CREATOR_A), cadence: "HOURLY" }];

    await expect(
      runDueReportSchedules({ now: new Date("2026-09-02T09:00:00Z") }),
    ).rejects.toThrowError();
    expect(produceDailyCreatorReport).not.toHaveBeenCalled();
  });
});

describe("reportDateFor", () => {
  it("resolves the calendar date in the schedule's timezone", () => {
    const instant = new Date("2026-09-02T09:00:00Z");
    expect(reportDateFor(instant, "America/Los_Angeles")).toBe("2026-09-02");
    expect(reportDateFor(new Date("2026-09-02T05:00:00Z"), "America/Los_Angeles")).toBe(
      "2026-09-01",
    );
    expect(reportDateFor(instant, "Pacific/Auckland")).toBe("2026-09-02");
    expect(reportDateFor(new Date("2026-09-02T22:00:00Z"), "Pacific/Auckland")).toBe("2026-09-03");
  });

  it("falls back to UTC for a missing or unusable timezone", () => {
    const instant = new Date("2026-09-02T22:00:00Z");
    expect(reportDateFor(instant, null)).toBe("2026-09-02");
    expect(reportDateFor(instant, "Not/AZone")).toBe("2026-09-02");
  });
});

/**
 * Structural guard: there is exactly one thing in this repository that decides
 * when a report is due.
 *
 * A Vercel cron hitting an API route, or a second Inngest cron function, would
 * be a competing source of truth for schedule state — two writers racing on the
 * same next_due_at, and reports produced twice or not at all depending on which
 * one won. The atomic claim only protects against concurrent runs of the same
 * scheduler.
 */
describe("single scheduler", () => {
  const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

  function walk(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith(".ts") ? [full] : [];
    });
  }

  it("declares no Vercel cron alongside the Inngest scheduler", () => {
    const config: unknown = JSON.parse(
      readFileSync(path.join(WEB, "..", "..", "vercel.json"), "utf8"),
    );
    expect((config as { crons?: unknown }).crons).toBeUndefined();
  });

  it("registers exactly one cron trigger", () => {
    const withCron = walk(path.join(WEB, "src"))
      .filter((file) => !file.endsWith(".test.ts"))
      .flatMap((file) => {
        const matches = readFileSync(file, "utf8").match(/triggers:\s*\[\s*\{\s*cron:/g);
        return matches ? matches.map(() => path.relative(WEB, file)) : [];
      });
    expect(withCron).toEqual([path.join("src", "lib", "inngest.ts")]);
  });
});

describe("cadence", () => {
  it("does not regenerate the daily report for a WEEKLY schedule", async () => {
    // Adversarial review, confirmed: cadence was never branched on, so a WEEKLY
    // schedule upserted onto the same (creator_id, report_date) row as that
    // day's daily report and reported PRODUCED — a weekly review that never
    // existed, reported as running.
    dueSchedules = [{ ...schedule(SCHEDULE_A, CREATOR_A), cadence: "WEEKLY" }];

    const outcome = await runDueReportSchedules({ now: new Date("2026-09-02T09:00:00Z") });

    expect(produceDailyCreatorReport).not.toHaveBeenCalled();
    expect(outcome.outcomes[0]).toMatchObject({
      status: "SKIPPED",
      reason: "WEEKLY_REVIEW_NOT_IMPLEMENTED",
    });
    // Persisted, so an operator can see it on the schedule.
    expect(resultsFor("record_report_schedule_result")[0]?.args).toMatchObject({
      p_status: "SKIPPED",
      p_error: "WEEKLY_REVIEW_NOT_IMPLEMENTED",
    });
  });

  it("still runs DAILY schedules in the same batch", async () => {
    dueSchedules = [
      { ...schedule(SCHEDULE_A, CREATOR_A), cadence: "WEEKLY" },
      schedule(SCHEDULE_B, CREATOR_B),
    ];

    const outcome = await runDueReportSchedules({ now: new Date("2026-09-02T09:00:00Z") });

    expect(outcome.outcomes.map((entry) => entry.status)).toEqual(["SKIPPED", "PRODUCED"]);
    expect(produceDailyCreatorReport).toHaveBeenCalledTimes(1);
  });
});
