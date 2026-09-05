import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The producer must refuse rather than invent. A report generated without a
 * frozen baseline compares against nothing, so every "change" in it would be
 * fabricated — the exact failure the Foundry operating rules forbid.
 */
interface TableResult {
  data: unknown;
  error: null | { message: string };
}

const tables = new Map<string, TableResult>();
const writes: Array<{ table: string; payload: Record<string, unknown> }> = [];

const bounds: Array<{ table: string; op: string; column: string; value: unknown }> = [];

function makeQuery(table: string) {
  const chain: Record<string, unknown> = {};
  const result = () => Promise.resolve(tables.get(table) ?? { data: null, error: null });
  for (const op of ["select", "eq", "order", "limit", "in", "is"]) chain[op] = () => chain;
  for (const op of ["gte", "lte", "lt"])
    chain[op] = (column: string, value: unknown) => {
      bounds.push({ table, op, column, value });
      return chain;
    };
  chain["upsert"] = (payload: Record<string, unknown>) => {
    writes.push({ table, payload });
    return chain;
  };
  chain["maybeSingle"] = result;
  chain["single"] = result;
  chain["then"] = (resolve: (value: unknown) => unknown) => resolve(result());
  return chain;
}

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ from: (table: string) => makeQuery(table) }),
}));

const { produceDailyCreatorReport } = await import("./daily-report");

const ORG = "11111111-1111-4111-8111-111111111111";
const CREATOR = "22222222-2222-4222-8222-222222222222";

const baselineMetrics = {
  date: "2026-08-01",
  reach: 10_000,
  profileVisits: 800,
  outboundClicks: 200,
  newSubscribers: 100,
  firstBuyers: 30,
  revenue: 5000,
};

beforeEach(() => {
  tables.clear();
  writes.length = 0;
  bounds.length = 0;
  tables.set("creators", {
    data: {
      id: CREATOR,
      stage_name: "Madison Carter",
      current_health_score: 71,
      current_content_buffer_days: 12,
    },
    error: null,
  });
});

describe("daily report production", () => {
  it("refuses when the creator does not belong to the organization", async () => {
    tables.set("creators", { data: null, error: null });
    expect(await produceDailyCreatorReport({ organizationId: ORG, creatorId: CREATOR })).toEqual({
      produced: false,
      reason: "CREATOR_NOT_FOUND",
    });
    expect(writes).toHaveLength(0);
  });

  it("refuses when no baseline has been frozen, rather than comparing against zero", async () => {
    tables.set("creator_baselines", { data: null, error: null });
    expect(await produceDailyCreatorReport({ organizationId: ORG, creatorId: CREATOR })).toEqual({
      produced: false,
      reason: "NO_BASELINE_FROZEN",
    });
    // Nothing is written: a report is not produced on an invented comparison.
    expect(writes).toHaveLength(0);
  });

  it("refuses when the stored baseline is not a usable metric point", async () => {
    tables.set("creator_baselines", { data: { metrics_json: { garbage: true } }, error: null });
    expect(await produceDailyCreatorReport({ organizationId: ORG, creatorId: CREATOR })).toEqual({
      produced: false,
      reason: "NO_BASELINE_FROZEN",
    });
  });

  it("refuses when no metrics exist for the period", async () => {
    tables.set("creator_baselines", { data: { metrics_json: baselineMetrics }, error: null });
    tables.set("creator_revenue_daily", { data: [], error: null });
    tables.set("social_posts", { data: [], error: null });
    // The producer reads back the id it upserted.
    tables.set("daily_creator_reports", {
      data: { id: "55555555-5555-4555-8555-555555555555" },
      error: null,
    });
    expect(await produceDailyCreatorReport({ organizationId: ORG, creatorId: CREATOR })).toEqual({
      produced: false,
      reason: "NO_METRICS_FOR_PERIOD",
    });
    expect(writes).toHaveLength(0);
  });

  it("produces and stores a report when a baseline and metrics both exist", async () => {
    tables.set("creator_baselines", { data: { metrics_json: baselineMetrics }, error: null });
    tables.set("creator_revenue_daily", {
      data: [
        {
          date: "2026-09-01",
          creator_platform_receipts: 900,
          new_subscribers: 12,
          first_buyers: 4,
        },
        {
          date: "2026-09-02",
          creator_platform_receipts: 1100,
          new_subscribers: 18,
          first_buyers: 6,
        },
      ],
      error: null,
    });
    tables.set("social_posts", {
      data: [{ reach: 4000, profile_visits: 300, outbound_clicks: 90 }],
      error: null,
    });
    tables.set("daily_creator_reports", {
      data: { id: "33333333-3333-4333-8333-333333333333" },
      error: null,
    });

    const outcome = await produceDailyCreatorReport({ organizationId: ORG, creatorId: CREATOR });
    expect(outcome.produced).toBe(true);

    const write = writes.find((entry) => entry.table === "daily_creator_reports");
    expect(write?.payload["organization_id"]).toBe(ORG);
    expect(write?.payload["creator_id"]).toBe(CREATOR);
    expect(write?.payload["provider"]).toBe("RULES");
    // Metrics are summed from the real rows, not carried over from the baseline.
    expect(write?.payload["metrics_json"]).toMatchObject({
      revenue: 2000,
      newSubscribers: 30,
      firstBuyers: 10,
      reach: 4000,
    });
    // Data quality travels with the report so partial data is visible as such.
    expect(write?.payload["data_quality_json"]).toMatchObject({ revenueDays: 2, socialPosts: 1 });
  });
});

/**
 * Adversarial review, confirmed twice over. Nothing in the application writes
 * creators.current_health_score, and the report hardcoded contentBufferDays to
 * zero, so every report for every real creator was stored as health CRITICAL
 * with a fabricated "content buffer is critical at 0 days" anomaly — and the
 * operator could turn that anomaly into a real CRITICAL task with one click.
 */
describe("absent measurements", () => {
  const baseline = { ...baselineMetrics };

  function withMetrics() {
    tables.set("creator_baselines", { data: { metrics_json: baseline }, error: null });
    tables.set("creator_revenue_daily", {
      data: [
        {
          date: "2026-09-01",
          creator_platform_receipts: 900,
          new_subscribers: 40,
          first_buyers: 9,
        },
      ],
      error: null,
    });
    tables.set("social_posts", {
      data: [{ reach: 5000, profile_visits: 300, outbound_clicks: 90 }],
      error: null,
    });
    tables.set("daily_creator_reports", {
      data: { id: "66666666-6666-4666-8666-666666666666" },
      error: null,
    });
  }

  it("reports an unmeasured health score as UNKNOWN, not CRITICAL", async () => {
    withMetrics();
    tables.set("creators", {
      data: {
        id: CREATOR,
        stage_name: "Madison Carter",
        current_health_score: null,
        current_content_buffer_days: 12,
      },
      error: null,
    });

    await produceDailyCreatorReport({ organizationId: ORG, creatorId: CREATOR });

    const written = writes.find((entry) => entry.table === "daily_creator_reports");
    expect(written?.payload["health_status"]).toBe("UNKNOWN");
  });

  it("raises no content-buffer anomaly when the buffer was never measured", async () => {
    withMetrics();
    tables.set("creators", {
      data: {
        id: CREATOR,
        stage_name: "Madison Carter",
        current_health_score: 71,
        current_content_buffer_days: null,
      },
      error: null,
    });

    await produceDailyCreatorReport({ organizationId: ORG, creatorId: CREATOR });

    const written = writes.find((entry) => entry.table === "daily_creator_reports");
    const anomalies = JSON.stringify(written?.payload["anomalies_json"]);
    expect(anomalies).not.toContain("Content buffer");
    // priority is the operator's triage signal. If every report is CRITICAL, a
    // genuine CRITICAL is indistinguishable from the noise floor.
    expect(written?.payload["priority"]).not.toBe("CRITICAL");
  });

  it("still raises the anomaly when the buffer is genuinely low", async () => {
    withMetrics();
    tables.set("creators", {
      data: {
        id: CREATOR,
        stage_name: "Madison Carter",
        current_health_score: 71,
        current_content_buffer_days: 2,
      },
      error: null,
    });

    await produceDailyCreatorReport({ organizationId: ORG, creatorId: CREATOR });

    const written = writes.find((entry) => entry.table === "daily_creator_reports");
    expect(JSON.stringify(written?.payload["anomalies_json"])).toContain("critical at 2 days");
  });
});

describe("baseline window normalisation", () => {
  /**
   * Regression from the first real report produced in staging: a creator whose
   * daily numbers had not moved was reported at -73% revenue and -73%
   * acquisition, because a 7-day current sum was compared against a 31-day
   * baseline sum. The baseline's own period_start/period_end existed from the
   * first migration and were never read.
   */
  it("reports no material change for a creator performing exactly at baseline", async () => {
    // 31-day baseline; the creator sustains the same daily rate through the
    // 7-day current window.
    const perDay = { revenue: 200, newSubscribers: 4, firstBuyers: 1 };
    tables.set("creator_baselines", {
      data: {
        metrics_json: {
          date: "2026-08-24",
          reach: 0,
          profileVisits: 0,
          outboundClicks: 0,
          newSubscribers: perDay.newSubscribers * 31,
          firstBuyers: perDay.firstBuyers * 31,
          revenue: perDay.revenue * 31,
        },
        period_start: "2026-07-25",
        period_end: "2026-08-24",
      },
      error: null,
    });
    tables.set("creator_revenue_daily", {
      data: Array.from({ length: 7 }, (_, i) => ({
        date: `2026-08-2${i + 1}`,
        creator_platform_receipts: perDay.revenue,
        new_subscribers: perDay.newSubscribers,
        first_buyers: perDay.firstBuyers,
      })),
      error: null,
    });
    tables.set("social_posts", { data: [], error: null });
    // The producer reads back the id it upserted.
    tables.set("daily_creator_reports", {
      data: { id: "55555555-5555-4555-8555-555555555555" },
      error: null,
    });

    const result = await produceDailyCreatorReport({ organizationId: ORG, creatorId: CREATOR });
    expect(result.produced).toBe(true);

    const write = writes.find((entry) => entry.table === "daily_creator_reports");
    const quality = write?.payload["data_quality_json"] as {
      comparisons: Record<string, number | null>;
      baselineWindowDays: number | null;
      baselineScaledToWindow: boolean;
    };

    expect(quality.baselineWindowDays).toBe(31);
    expect(quality.baselineScaledToWindow).toBe(true);
    // Flat performance reads as flat, not as a collapse.
    expect(Math.abs(quality.comparisons["revenue"] ?? 999)).toBeLessThan(1);
    expect(Math.abs(quality.comparisons["acquisition"] ?? 999)).toBeLessThan(1);
  });

  it("still compares, and says it did not scale, when the baseline period is unreadable", async () => {
    tables.set("creator_baselines", {
      data: { metrics_json: baselineMetrics, period_start: null, period_end: null },
      error: null,
    });
    tables.set("creator_revenue_daily", {
      data: [{ date: "2026-08-21", creator_platform_receipts: 100, new_subscribers: 2, first_buyers: 1 }],
      error: null,
    });
    tables.set("social_posts", { data: [], error: null });
    // The producer reads back the id it upserted.
    tables.set("daily_creator_reports", {
      data: { id: "55555555-5555-4555-8555-555555555555" },
      error: null,
    });

    const result = await produceDailyCreatorReport({ organizationId: ORG, creatorId: CREATOR });
    expect(result.produced).toBe(true);
    const write = writes.find((entry) => entry.table === "daily_creator_reports");
    const quality = write?.payload["data_quality_json"] as { baselineScaledToWindow: boolean };
    // Not silently treated as a same-length window.
    expect(quality.baselineScaledToWindow).toBe(false);
  });
});

describe("the declared window matches the queried window", () => {
  /**
   * The bug this guards: the producer declared a 7-day window and scaled the
   * baseline by 7, while `.gte(date, isoDaysAgo(7))` with no upper bound
   * selects `since … today` -- eight calendar dates. A creator performing
   * exactly at baseline therefore read as +14.29%, and that figure reaches a
   * real rule gate (`acquisitionChange >= 5`).
   *
   * Asserting the bound the code actually queries with, rather than trusting
   * the constant, is the only way this class of drift is caught: the previous
   * test fed the harness exactly seven rows and so agreed with whichever
   * window the code believed in.
   */
  function seedWindowFixtures() {
    tables.set("creator_baselines", {
      data: { metrics_json: baselineMetrics, period_start: "2026-07-25", period_end: "2026-08-24" },
      error: null,
    });
    tables.set("creator_revenue_daily", {
      data: [
        { date: "2026-08-28", creator_platform_receipts: 100, new_subscribers: 2, first_buyers: 1 },
      ],
      error: null,
    });
    tables.set("social_posts", { data: [], error: null });
    tables.set("daily_creator_reports", {
      data: { id: "55555555-5555-4555-8555-555555555555" },
      error: null,
    });
  }

  function boundFor(table: string, op: string) {
    return bounds.find((entry) => entry.table === table && entry.op === op);
  }

  function daysBetweenInclusive(since: string, until: string) {
    return (
      Math.round(
        (Date.parse(`${until}T00:00:00.000Z`) - Date.parse(`${since}T00:00:00.000Z`)) / 86_400_000,
      ) + 1
    );
  }

  it("bounds the revenue query to exactly the number of days it claims", async () => {
    seedWindowFixtures();
    const result = await produceDailyCreatorReport({ organizationId: ORG, creatorId: CREATOR });
    expect(result.produced).toBe(true);

    const write = writes.find((entry) => entry.table === "daily_creator_reports");
    const declaredDays = (write?.payload["data_quality_json"] as { currentWindowDays: number })
      .currentWindowDays;

    const lower = boundFor("creator_revenue_daily", "gte");
    const upper = boundFor("creator_revenue_daily", "lte");
    expect(lower?.column).toBe("date");
    // Without an upper bound the query is "everything from `since` onwards",
    // which silently picks up any row dated ahead of the report and brings the
    // 7-vs-8 drift straight back.
    expect(upper?.column).toBe("date");

    expect(daysBetweenInclusive(String(lower?.value), String(upper?.value))).toBe(declaredDays);
  });

  /**
   * `social_posts.published_at` is a timestamptz, so its bounds are instants
   * rather than dates and are built separately. The previous test asserted only
   * the revenue bound, which left the social window free to drift on its own.
   */
  it("covers the same days in the social query, to the instant", async () => {
    seedWindowFixtures();
    await produceDailyCreatorReport({ organizationId: ORG, creatorId: CREATOR });

    const revenueLower = String(boundFor("creator_revenue_daily", "gte")?.value);
    const revenueUpper = String(boundFor("creator_revenue_daily", "lte")?.value);
    const socialLower = boundFor("social_posts", "gte");
    const socialUpper = boundFor("social_posts", "lt");

    expect(socialLower?.column).toBe("published_at");
    expect(socialUpper?.column).toBe("published_at");
    // Starts at the first moment of the first day...
    expect(socialLower?.value).toBe(`${revenueLower}T00:00:00.000Z`);
    // ...and stops at the first moment of the day after the last, exclusive,
    // so every moment of the final day counts and none of the next one does.
    const dayAfter = new Date(Date.parse(`${revenueUpper}T00:00:00.000Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(socialUpper?.value).toBe(`${dayAfter}T00:00:00.000Z`);
  });

  /**
   * The scheduler dates each report in the creator's own timezone
   * (`reportDateFor(now, schedule.timezone)`), so two creators processed in the
   * same tick can be given different report dates. A window anchored to the
   * server's UTC "now" summed the same seven days for both, and the report
   * dated tomorrow described yesterday's window while claiming a 7-day one.
   */
  it("anchors the window to the report date it was given, not to the server clock", async () => {
    seedWindowFixtures();
    await produceDailyCreatorReport({
      organizationId: ORG,
      creatorId: CREATOR,
      reportDate: "2026-08-30",
    });

    expect(boundFor("creator_revenue_daily", "lte")?.value).toBe("2026-08-30");
    // Seven inclusive days ending on the report's own date.
    expect(boundFor("creator_revenue_daily", "gte")?.value).toBe("2026-08-24");
  });
});

/**
 * The guards that make a second ingestion path safe.
 *
 * `social_posts` has no writer yet, so every one of these paths is currently
 * unreachable — which is exactly why they need pinning before one exists. The
 * skip above fires only when BOTH dimensions are empty, so the first social
 * row that ever lands changes the behaviour of every creator whose revenue
 * reporting has gone quiet.
 */
describe("a dimension nobody measured is not compared as though it read zero", () => {
  function seed(options: {
    revenue?: Array<Record<string, unknown>>;
    social?: Array<Record<string, unknown>>;
    baseline: Record<string, unknown>;
  }) {
    tables.set("creator_baselines", {
      data: { metrics_json: options.baseline, period_start: "2026-08-28", period_end: "2026-09-03" },
      error: null,
    });
    tables.set("creator_revenue_daily", { data: options.revenue ?? [], error: null });
    tables.set("social_posts", { data: options.social ?? [], error: null });
    tables.set("daily_creator_reports", {
      data: { id: "55555555-5555-4555-8555-555555555555" },
      error: null,
    });
  }

  function quality() {
    const write = writes.find((entry) => entry.table === "daily_creator_reports");
    return write?.payload["data_quality_json"] as {
      comparisons: Record<string, number | null>;
      unmeasuredThisWindow: string[];
      unmeasuredInBaseline: string[];
      incomparableDimensions: string[];
    };
  }

  it("does not invent a revenue collapse for a creator whose revenue was never ingested", async () => {
    // Social data present, revenue absent. Before the guard the revenue sum was
    // 0 against a non-zero baseline, i.e. -100%, and the rules engine read that
    // as a catastrophic collapse rather than as an absent measurement.
    seed({
      social: [{ reach: 5000, profile_visits: 400, outbound_clicks: 100 }],
      baseline: baselineMetrics,
    });

    const result = await produceDailyCreatorReport({ organizationId: ORG, creatorId: CREATOR });
    expect(result.produced).toBe(true);

    expect(quality().comparisons["revenue"]).toBeNull();
    expect(quality().comparisons["acquisition"]).toBeNull();
    expect(quality().unmeasuredThisWindow).toEqual(
      expect.arrayContaining(["newSubscribers", "firstBuyers", "revenue"]),
    );
  });

  it("still compares the dimension that WAS measured", async () => {
    // The guard must neutralise only the absent dimension. Neutralising the
    // whole report would trade a false alarm for a blind spot.
    seed({
      social: [{ reach: 20_000, profile_visits: 400, outbound_clicks: 100 }],
      baseline: baselineMetrics,
    });

    await produceDailyCreatorReport({ organizationId: ORG, creatorId: CREATOR });
    expect(quality().comparisons["reach"]).not.toBeNull();
  });

  /**
   * The baseline marker is EXPLANATORY, not load-bearing, and this test says
   * so deliberately.
   *
   * A dimension the freeze recorded as unmeasured also stored 0 for it, and a
   * zero baseline already yields a null comparison — so neutralising it again
   * changes no arithmetic. What the marker buys is the ability to tell "reach
   * 0 because nobody measured it" from "reach 0 because it was measured at
   * zero", in the one artifact that is permanent. Asserting it appears in the
   * report's data quality is therefore the honest assertion; asserting it
   * changes the comparison would pass for the wrong reason.
   */
  it("carries the baseline's record of what it never measured into the report", async () => {
    seed({
      revenue: [{ date: "2026-09-01", creator_platform_receipts: 900, new_subscribers: 18, first_buyers: 5 }],
      social: [{ reach: 50_000, profile_visits: 900, outbound_clicks: 300 }],
      baseline: {
        ...baselineMetrics,
        reach: 0,
        profileVisits: 0,
        outboundClicks: 0,
        unmeasuredDimensions: ["reach", "profileVisits", "outboundClicks"],
      },
    });

    await produceDailyCreatorReport({ organizationId: ORG, creatorId: CREATOR });
    // The marker reaches the report, which is the whole point of storing it.
    expect(quality().unmeasuredInBaseline).toEqual(
      expect.arrayContaining(["reach", "profileVisits", "outboundClicks"]),
    );
    expect(quality().incomparableDimensions).toEqual(expect.arrayContaining(["reach"]));
    // ...while the revenue side, measured on both sides, still compares.
    expect(quality().comparisons["revenue"]).not.toBeNull();
  });

  it("ignores a stored marker naming something that is not a real dimension", async () => {
    // metrics_json is free-form and may have been written by older code; a
    // bogus entry must not silently zero a dimension that IS comparable.
    seed({
      revenue: [{ date: "2026-09-01", creator_platform_receipts: 900, new_subscribers: 18, first_buyers: 5 }],
      baseline: { ...baselineMetrics, unmeasuredDimensions: ["revenue; drop table", "__proto__"] },
    });

    await produceDailyCreatorReport({ organizationId: ORG, creatorId: CREATOR });
    expect(quality().comparisons["revenue"]).not.toBeNull();
    expect(quality().incomparableDimensions).not.toContain("revenue");
  });

  it("still refuses outright when nothing at all was measured", async () => {
    seed({ baseline: baselineMetrics });
    expect(await produceDailyCreatorReport({ organizationId: ORG, creatorId: CREATOR })).toEqual({
      produced: false,
      reason: "NO_METRICS_FOR_PERIOD",
    });
  });

  it("reads a baseline frozen before the marker existed", async () => {
    // Backward compatibility: the marker is absent on every baseline frozen to
    // date, and those must keep producing reports rather than throwing.
    seed({
      revenue: [{ date: "2026-09-01", creator_platform_receipts: 900, new_subscribers: 18, first_buyers: 5 }],
      baseline: baselineMetrics,
    });
    const result = await produceDailyCreatorReport({ organizationId: ORG, creatorId: CREATOR });
    expect(result.produced).toBe(true);
  });
});

/**
 * A window nobody has finished entering must not read as a window in which
 * performance collapsed.
 *
 * Foundry types revenue in by hand. On any day before the week is fully
 * entered -- which is most days, and every day for a creator onboarded
 * mid-week -- `creator_revenue_daily` holds fewer than seven days while the
 * baseline was being scaled onto a full seven. A creator performing exactly at
 * her own baseline read as a 71% revenue collapse, and that number is printed
 * on a report she can be shown.
 *
 * The guard that existed only fired on ZERO rows, so it never saw the case
 * that actually happens.
 */
describe("a partly-entered window is compared against a partly-entered baseline", () => {
  const REPORT_DATE = "2026-09-04";

  function seed(revenueRows: Array<Record<string, unknown>>, baselineExtras: object = {}) {
    tables.set("creator_baselines", {
      data: {
        // 30 calendar days. 5000 over 30 days is 166.67/day.
        metrics_json: { ...baselineMetrics, ...baselineExtras },
        period_start: "2026-08-01",
        period_end: "2026-08-30",
      },
      error: null,
    });
    tables.set("creator_revenue_daily", { data: revenueRows, error: null });
    tables.set("social_posts", { data: [], error: null });
    tables.set("daily_creator_reports", {
      data: { id: "66666666-6666-4666-8666-666666666666" },
      error: null,
    });
  }

  async function quality() {
    const result = await produceDailyCreatorReport({
      organizationId: ORG,
      creatorId: CREATOR,
      reportDate: REPORT_DATE,
    });
    expect(result.produced).toBe(true);
    const write = writes.find((entry) => entry.table === "daily_creator_reports");
    return write?.payload["data_quality_json"] as {
      comparisons: Record<string, number | null>;
      revenueDays: number;
      socialDays: number;
      socialPosts: number;
      revenueRows: number;
      baselineRevenueDays: number | null;
      baselineScaleFactors: { social: number; revenue: number };
    };
  }

  it("reads two entered days of exactly baseline performance as flat, not as a collapse", async () => {
    // 166.67/day is precisely the baseline's own daily rate.
    seed([
      { date: "2026-09-03", creator_platform_receipts: 166.67, new_subscribers: 3.33, first_buyers: 1 },
      { date: "2026-09-04", creator_platform_receipts: 166.67, new_subscribers: 3.33, first_buyers: 1 },
    ]);
    const stored = await quality();

    expect(stored.revenueDays).toBe(2);
    // Scaled by measured days over baseline days, not by the whole window.
    expect(stored.baselineScaleFactors.revenue).toBeCloseTo(2 / 30, 10);
    // The old arithmetic (7/30) put this at roughly -71%.
    expect(Math.abs(stored.comparisons["revenue"] ?? 999)).toBeLessThan(1);
    expect(Math.abs(stored.comparisons["acquisition"] ?? 999)).toBeLessThan(1);
  });

  it("scales against the baseline's own measured days when the baseline recorded them", async () => {
    // A 30-day period holding only 10 entered days: 5000 is a 10-day sum at
    // 500/day, not a 30-day sum at 166.67/day.
    seed(
      [
        { date: "2026-09-02", creator_platform_receipts: 500, new_subscribers: 10, first_buyers: 3 },
        { date: "2026-09-03", creator_platform_receipts: 500, new_subscribers: 10, first_buyers: 3 },
        { date: "2026-09-04", creator_platform_receipts: 500, new_subscribers: 10, first_buyers: 3 },
      ],
      { measuredDays: { revenue: 10, social: 0 } },
    );
    const stored = await quality();

    expect(stored.baselineRevenueDays).toBe(10);
    expect(stored.baselineScaleFactors.revenue).toBeCloseTo(3 / 10, 10);
    // Reading the period as 30 fully-measured days would have made this +200%.
    expect(Math.abs(stored.comparisons["revenue"] ?? 999)).toBeLessThan(1);
  });

  it("falls back to the calendar period for baselines frozen before coverage was recorded", async () => {
    seed([
      { date: "2026-09-04", creator_platform_receipts: 166.67, new_subscribers: 3.33, first_buyers: 1 },
    ]);
    const stored = await quality();
    expect(stored.baselineRevenueDays).toBe(30);
    expect(stored.baselineScaleFactors.revenue).toBeCloseTo(1 / 30, 10);
  });

  it("counts measured DAYS, not rows: two platforms reporting one day is one day", async () => {
    seed([
      {
        date: "2026-09-04",
        platform: "ONLYFANS",
        creator_platform_receipts: 100,
        new_subscribers: 2,
        first_buyers: 1,
      },
      {
        date: "2026-09-04",
        platform: "FANSLY",
        creator_platform_receipts: 60,
        new_subscribers: 1,
        first_buyers: 0,
      },
    ]);
    const stored = await quality();

    // Both rows are kept -- they are different platforms, not duplicates --
    // but they describe a single measured day.
    expect(stored.revenueRows).toBe(2);
    expect(stored.revenueDays).toBe(1);
    expect(stored.baselineScaleFactors.revenue).toBeCloseTo(1 / 30, 10);
  });

  /**
   * Social is deliberately NOT scaled this way. `social_posts` is a log of
   * events, so a day holding no row genuinely produced no post reach --
   * unlike the revenue ledger, where a missing day means nobody typed it in.
   * Scaling reach by posting days would hide a drop in posting cadence, which
   * is one of the few things this report exists to catch.
   */
  it("keeps social on the full calendar window, because a day without a post is not a day unmeasured", async () => {
    tables.set("creator_baselines", {
      data: {
        metrics_json: baselineMetrics,
        period_start: "2026-08-01",
        period_end: "2026-08-30",
      },
      error: null,
    });
    tables.set("creator_revenue_daily", { data: [], error: null });
    tables.set("social_posts", {
      data: [
        { published_at: "2026-09-03T10:00:00Z", reach: 1000, profile_visits: 40, outbound_clicks: 9 },
        { published_at: "2026-09-03T18:00:00Z", reach: 1000, profile_visits: 40, outbound_clicks: 9 },
        { published_at: "2026-09-04T09:00:00Z", reach: 333, profile_visits: 10, outbound_clicks: 3 },
      ],
      error: null,
    });
    tables.set("daily_creator_reports", {
      data: { id: "66666666-6666-4666-8666-666666666666" },
      error: null,
    });
    const stored = await quality();

    // Three posts across two calendar days: both are recorded, and they are
    // different numbers.
    expect(stored.socialPosts).toBe(3);
    expect(stored.socialDays).toBe(2);
    expect(stored.baselineScaleFactors.social).toBeCloseTo(7 / 30, 10);
    // 10000 reach over 30 days scaled to 7 is 2333.3; the window measured
    // 2333 -- flat, and unaffected by how many days held a post.
    expect(Math.abs(stored.comparisons["reach"] ?? 999)).toBeLessThan(1);
  });
});
