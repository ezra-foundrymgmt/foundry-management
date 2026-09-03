import "server-only";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { produceDailyCreatorReport } from "@/lib/daily-report";

const dueScheduleSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  creator_id: z.string().uuid(),
  cadence: z.enum(["DAILY", "WEEKLY"]),
  timezone: z.string().nullable(),
});

export interface ScheduleOutcome {
  scheduleId: string;
  creatorId: string;
  cadence: "DAILY" | "WEEKLY";
  status: "PRODUCED" | "SKIPPED" | "FAILED";
  reason?: string;
  reportId?: string;
}

function admin() {
  const client = createSupabaseAdminClient();
  if (!client) throw new Error("DATABASE_NOT_CONFIGURED");
  return client;
}

/**
 * The calendar date "now" falls on in the schedule's timezone.
 *
 * A creator in Los Angeles should get the report for their day, not for UTC's.
 * Using the UTC date would silently produce the wrong day's report for most of
 * the evening in western timezones. An unknown or invalid timezone falls back to
 * UTC rather than throwing — a wrong-by-hours date is better than no report.
 */
export function reportDateFor(now: Date, timezone: string | null): string {
  if (!timezone) return now.toISOString().slice(0, 10);
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * Runs every report schedule that is due.
 *
 * Claiming and advancing happen in one SQL statement, so two overlapping
 * scheduler invocations cannot both pick up the same schedule. Report writes are
 * upserted on (creator_id, report_date), so even if a claim were somehow
 * repeated the result is one report per creator per day, not two.
 *
 * A schedule whose creator has no frozen baseline is recorded as SKIPPED with
 * the reason. It is not an error and it does not produce an invented report.
 */
export async function runDueReportSchedules(options: { now?: Date; limit?: number } = {}): Promise<{
  claimed: number;
  outcomes: ScheduleOutcome[];
}> {
  const client = admin();
  const now = options.now ?? new Date();
  const limit = options.limit ?? 50;

  const { data, error } = await client.rpc("claim_due_report_schedules", {
    p_now: now.toISOString(),
    p_limit: limit,
  });
  if (error) throw new Error(`SCHEDULE_CLAIM_FAILED: ${error.message}`);
  const schedules = z.array(dueScheduleSchema).parse(data ?? []);

  const outcomes: ScheduleOutcome[] = [];
  for (const schedule of schedules) {
    const base: Pick<ScheduleOutcome, "scheduleId" | "creatorId" | "cadence"> = {
      scheduleId: schedule.id,
      creatorId: schedule.creator_id,
      cadence: schedule.cadence,
    };
    try {
      // Adversarial review, confirmed: cadence was never branched on, so a
      // WEEKLY schedule regenerated that day's daily report — upserted onto the
      // same (creator_id, report_date) row — and reported PRODUCED. The weekly
      // review nobody had written looked like it was running.
      //
      // There is no weekly producer yet. Saying so is the whole point: an
      // operator can see WEEKLY_REVIEW_NOT_IMPLEMENTED on the schedule, which a
      // silently duplicated daily report would never have told them.
      if (schedule.cadence === "WEEKLY") {
        outcomes.push({ ...base, status: "SKIPPED", reason: "WEEKLY_REVIEW_NOT_IMPLEMENTED" });
        await recordResult(schedule.id, "SKIPPED", "WEEKLY_REVIEW_NOT_IMPLEMENTED");
        continue;
      }
      const result = await produceDailyCreatorReport({
        organizationId: schedule.organization_id,
        creatorId: schedule.creator_id,
        reportDate: reportDateFor(now, schedule.timezone),
      });
      if (result.produced) {
        outcomes.push({ ...base, status: "PRODUCED", reportId: result.reportId });
        await recordResult(schedule.id, "PRODUCED", null);
      } else {
        outcomes.push({ ...base, status: "SKIPPED", reason: result.reason });
        await recordResult(schedule.id, "SKIPPED", result.reason);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "UNKNOWN";
      // One failing schedule must not stop the rest of the run.
      outcomes.push({ ...base, status: "FAILED", reason: message });
      await recordResult(schedule.id, "FAILED", message).catch(() => undefined);
    }
  }

  return { claimed: schedules.length, outcomes };
}

async function recordResult(
  scheduleId: string,
  status: string,
  error: string | null,
): Promise<void> {
  const { error: writeError } = await admin().rpc("record_report_schedule_result", {
    p_schedule_id: scheduleId,
    p_status: status,
    p_error: error ? error.slice(0, 500) : null,
  });
  if (writeError) throw new Error(`SCHEDULE_RESULT_WRITE_FAILED: ${writeError.message}`);
}
