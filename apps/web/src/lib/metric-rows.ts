import "server-only";
import type { DataConfidence } from "@creatoros/domain";

/**
 * The READ side of the ingestion contract.
 *
 * `creator_revenue_daily`'s natural key is (creator_id, date, platform,
 * source), and that is deliberate — the import comment says two sources
 * reporting the same creator-day should "coexist as separate rows rather than
 * silently overwriting each other". But every consumer sums every row in the
 * window and nothing chooses between them, so two sources reporting the same
 * day are added together: $1000 and $1000 becomes $2000, 10 new subscribers
 * and 10 becomes 20. Verified against staging, not inferred.
 *
 * The design intent and the consumers were in direct contradiction. Holding two
 * claims about one creator-day is the right capability; what was missing is a
 * rule for which claim counts. That rule lives here.
 *
 * It is latent today only because a single source (OPERATOR_ENTRY) is in use.
 * Adding a second ingestion source is exactly what activates it.
 *
 * APPLIED AT THREE OF FIVE READERS, deliberately — the ones that produce a
 * claim or a permanent artifact: daily-report.ts, baselines.ts and
 * revenue-planner.ts. The two display reads in live-data.ts (the roster's
 * 60-day revenue sparkline and the same figure on Creator 360) would also
 * double-count and are NOT yet wired; they are display-only, so the error is
 * visible rather than frozen or acted on. That is a reason to sequence it
 * second, not a reason it is fine.
 *
 * KNOWN LIMITATION: the winner is chosen per ROW, not per field. If the losing
 * row measured a metric the winning row left null, that measurement is
 * dropped. Choosing per field would mix two readings into a composite row that
 * no source ever reported, which is a worse failure for a baseline that gets
 * frozen — but it does mean a partially-populated winner can lose information.
 */

/** Strongest first: the claim to prefer when two sources describe one period. */
const CONFIDENCE_RANK: Record<string, number> = {
  MEASURED: 0,
  PARTIALLY_MEASURED: 1,
  ESTIMATED: 2,
  UNKNOWN: 3,
};

function rank(confidence: string | null | undefined): number {
  return CONFIDENCE_RANK[confidence ?? "UNKNOWN"] ?? CONFIDENCE_RANK["UNKNOWN"]!;
}

export interface SourcedRow {
  // `| undefined` is explicit because this project enables
  // exactOptionalPropertyTypes, and zod's `.nullable().optional()` produces
  // exactly `string | null | undefined`.
  data_confidence?: string | null | undefined;
  /** Present on creator_revenue_daily; used only to break exact ties. */
  imported_at?: string | null | undefined;
}

/**
 * Keeps one row per natural period, choosing the most trustworthy claim.
 *
 * Precedence, in order:
 *   1. the strongest `data_confidence` — a measured figure beats an estimate;
 *   2. the most recent `imported_at` — a later correction beats an earlier
 *      reading at the same confidence;
 *   3. first seen, so the result is deterministic even when a tie survives
 *      both rules. A stable answer matters more than an arbitrary one here:
 *      `freezeBaseline` writes whatever this returns into a permanent record.
 *
 * Rows whose key cannot be determined are passed through untouched rather than
 * dropped — losing a measurement would be a worse failure than keeping a
 * duplicate, and the caller's key function is what decides.
 */
export function preferOneRowPerPeriod<Row extends SourcedRow>(
  rows: readonly Row[],
  keyOf: (row: Row) => string | null,
): Row[] {
  const best = new Map<string, Row>();
  const passthrough: Row[] = [];

  for (const row of rows) {
    const key = keyOf(row);
    if (key === null) {
      passthrough.push(row);
      continue;
    }
    const incumbent = best.get(key);
    if (incumbent === undefined) {
      best.set(key, row);
      continue;
    }
    if (beats(row, incumbent)) best.set(key, row);
  }

  return [...best.values(), ...passthrough];
}

function beats(candidate: SourcedRow, incumbent: SourcedRow): boolean {
  const byConfidence = rank(candidate.data_confidence) - rank(incumbent.data_confidence);
  if (byConfidence !== 0) return byConfidence < 0;

  const candidateAt = Date.parse(candidate.imported_at ?? "");
  const incumbentAt = Date.parse(incumbent.imported_at ?? "");
  // An unparseable or absent timestamp never displaces an incumbent: without a
  // known import time there is no evidence this row is the later correction.
  if (!Number.isFinite(candidateAt)) return false;
  if (!Number.isFinite(incumbentAt)) return true;
  return candidateAt > incumbentAt;
}

/**
 * How many distinct UTC calendar days a set of timestamps actually covers.
 *
 * Not the row count, which is what both the report producer and the baseline
 * freezer were recording under a field named `revenueDays`.
 * `creator_revenue_daily` is keyed per creator-day-platform, so a creator
 * selling on two platforms produces two rows for one day; `social_posts` holds
 * one row per post, so three posts on a Tuesday are one measured day, not
 * three. The report scales a frozen baseline by this number, so a row count
 * standing in for a day count scales the comparison by the wrong factor.
 *
 * Accepts both `YYYY-MM-DD` dates and full timestamps, because the two tables
 * store the two shapes. Anything unparseable is skipped rather than counted:
 * an unreadable timestamp is not evidence of a measured day.
 */
export function distinctDays(values: ReadonlyArray<string | null | undefined>): number {
  const days = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const parsed = Date.parse(value.length === 10 ? `${value}T00:00:00.000Z` : value);
    if (!Number.isFinite(parsed)) continue;
    days.add(new Date(parsed).toISOString().slice(0, 10));
  }
  return days.size;
}

/** Re-exported so callers can type a confidence without reaching for domain. */
export type { DataConfidence };
