import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The assembly layer, which is where a plan stops being arithmetic and starts
 * being a claim about a specific creator. Everything here is about proving it
 * reads the right rows and refuses rather than inventing.
 */
interface RecordedQuery {
  table: string;
  filters: Array<[string, string, unknown]>;
}

const recorded: RecordedQuery[] = [];
const tables = new Map<string, { data: unknown; error: null | { message: string } }>();

function makeQuery(table: string) {
  const entry: RecordedQuery = { table, filters: [] };
  recorded.push(entry);
  const chain: Record<string, unknown> = {};
  const result = () => Promise.resolve(tables.get(table) ?? { data: null, error: null });
  for (const op of ["select", "eq", "gte", "lte", "order", "limit", "in", "is"])
    chain[op] = (...args: unknown[]) => {
      entry.filters.push([op, typeof args[0] === "string" ? args[0] : "", args[1]]);
      return chain;
    };
  chain["maybeSingle"] = result;
  chain["single"] = result;
  chain["then"] = (resolve: (value: unknown) => unknown) => resolve(result());
  return chain;
}

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: (): { from: (table: string) => Record<string, unknown> } => ({
    from: (table: string) => makeQuery(table),
  }),
}));
vi.mock("@/lib/observability", () => ({
  logEvent: () => {
    /* discarded */
  },
}));

const { buildCreatorRevenuePlan, PlannerError } = await import("./revenue-planner");

const ORG = "11111111-1111-4111-8111-111111111111";
const CREATOR = "20000000-0000-4000-8000-000000000001";

const session = {
  userId: "22222222-2222-4222-8222-222222222222",
  organizationId: ORG,
  role: "super_admin" as const,
  email: "ezra@foundrymgmt.net",
};

/** A fully measured window: 1% visit, 20% click, 10% sub, 25% buy, $100/buyer. */
const measured = {
  date: "2026-08-31",
  reach: 1_000_000,
  profileVisits: 10_000,
  outboundClicks: 2_000,
  newSubscribers: 200,
  firstBuyers: 50,
  revenue: 5_000,
  unmeasuredDimensions: [] as string[],
};

function seed(options: { metrics?: unknown; achieved?: unknown[]; version?: number } = {}) {
  tables.set("creators", { data: { id: CREATOR }, error: null });
  tables.set("creator_baselines", {
    data: {
      metrics_json: options.metrics ?? measured,
      period_start: "2026-08-01",
      period_end: "2026-08-31",
      version: options.version ?? 3,
      baseline_type: "ROLLING_30D",
    },
    error: null,
  });
  tables.set("creator_revenue_daily", { data: options.achieved ?? [], error: null });
}

const request = { targetRevenue: 10_000, periodStart: "2026-09-01", periodEnd: "2026-09-30" };

beforeEach(() => {
  recorded.length = 0;
  tables.clear();
  // Fixed clock: elapsed-day arithmetic must be asserted against a known today.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-10T08:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the plan is scoped to the caller's organization", () => {
  it("proves the creator belongs to it before reading anything else", async () => {
    seed();
    await buildCreatorRevenuePlan(session, CREATOR, { ...request, baselineType: "ROLLING_30D" });
    const lookup = recorded.find((entry) => entry.table === "creators");
    expect(lookup?.filters).toEqual(
      expect.arrayContaining([
        ["eq", "organization_id", ORG],
        ["eq", "id", CREATOR],
      ]),
    );
  });

  it("refuses a creator from another tenant", async () => {
    seed();
    tables.set("creators", { data: null, error: null });
    await expect(
      buildCreatorRevenuePlan(session, CREATOR, { ...request, baselineType: "ROLLING_30D" }),
    ).rejects.toThrow("CREATOR_NOT_FOUND");
  });

  it("scopes the baseline and the achieved revenue to the organization too", async () => {
    seed();
    await buildCreatorRevenuePlan(session, CREATOR, { ...request, baselineType: "ROLLING_30D" });
    for (const table of ["creator_baselines", "creator_revenue_daily"]) {
      const query = recorded.find((entry) => entry.table === table);
      expect(query?.filters, table).toEqual(
        expect.arrayContaining([["eq", "organization_id", ORG]]),
      );
    }
  });
});

describe("it refuses rather than planning from nothing", () => {
  it("refuses when no baseline has been frozen", async () => {
    seed();
    tables.set("creator_baselines", { data: null, error: null });
    await expect(
      buildCreatorRevenuePlan(session, CREATOR, { ...request, baselineType: "ROLLING_30D" }),
    ).rejects.toThrow("NO_BASELINE_FROZEN");
  });

  it("refuses when the stored baseline is not a usable metric point", async () => {
    seed({ metrics: { garbage: true } });
    await expect(
      buildCreatorRevenuePlan(session, CREATOR, { ...request, baselineType: "ROLLING_30D" }),
    ).rejects.toThrow("NO_BASELINE_FROZEN");
  });

  it("refuses a period that ends before it starts", async () => {
    seed();
    await expect(
      buildCreatorRevenuePlan(session, CREATOR, {
        targetRevenue: 10_000,
        periodStart: "2026-09-30",
        periodEnd: "2026-09-01",
        baselineType: "ROLLING_30D",
      }),
    ).rejects.toThrow("PERIOD_START_AFTER_END");
  });

  it("never puts a driver message in the error the caller sees", async () => {
    seed();
    tables.set("creators", { data: null, error: { message: 'relation "creators" does not exist' } });
    await expect(
      buildCreatorRevenuePlan(session, CREATOR, { ...request, baselineType: "ROLLING_30D" }),
    ).rejects.toThrow("PLANNER_DATABASE_FAILED");
  });

  it("carries a status the route can turn into an HTTP code", () => {
    expect(new PlannerError("NO_BASELINE_FROZEN", 409).status).toBe(409);
  });
});

describe("it plans from one named baseline, not whichever version is highest", () => {
  it("pins the baseline type in the query", async () => {
    // Versions restart per baseline_type, so ordering by version across types
    // could return a QUARTERLY v5 when the operator meant a ROLLING_30D v3.
    seed();
    await buildCreatorRevenuePlan(session, CREATOR, { ...request, baselineType: "ROLLING_30D" });
    const query = recorded.find((entry) => entry.table === "creator_baselines");
    expect(query?.filters).toEqual(
      expect.arrayContaining([["eq", "baseline_type", "ROLLING_30D"]]),
    );
  });

  it("reports which baseline the figures came from", async () => {
    seed({ version: 7 });
    const result = await buildCreatorRevenuePlan(session, CREATOR, {
      ...request,
      baselineType: "ROLLING_30D",
    });
    expect(result.baselineVersion).toBe(7);
    expect(result.baselineType).toBe("ROLLING_30D");
    expect(result.baselinePeriod).toEqual({ start: "2026-08-01", end: "2026-08-31" });
  });
});

describe("achieved revenue and pacing", () => {
  it("does not double-count two sources reporting the same day", async () => {
    seed({
      achieved: [
        {
          date: "2026-09-02",
          platform: "ONLYFANS",
          imported_at: "2026-09-03T00:00:00+00:00",
          data_confidence: "MEASURED",
          creator_platform_receipts: 1_000,
        },
        {
          date: "2026-09-02",
          platform: "ONLYFANS",
          imported_at: "2026-09-04T00:00:00+00:00",
          data_confidence: "ESTIMATED",
          creator_platform_receipts: 1_000,
        },
      ],
    });
    const result = await buildCreatorRevenuePlan(session, CREATOR, {
      ...request,
      baselineType: "ROLLING_30D",
    });
    // One creator-day, one claim: the MEASURED one, not the sum.
    expect(result.pace.achievedRevenue).toBe(1_000);
    expect(result.achievedFrom.rows).toBe(1);
  });

  it("counts only the days that have actually finished", async () => {
    // Clock is 2026-09-10 and the period began 2026-09-01, so nine days are
    // complete and the tenth is in progress. Counting the day in progress was
    // the off-by-one that made a creator dead on pace read BEHIND.
    seed();
    const result = await buildCreatorRevenuePlan(session, CREATOR, {
      ...request,
      baselineType: "ROLLING_30D",
    });
    expect(result.pace.elapsedFraction).toBeCloseTo(9 / 30, 5);
  });

  it("does not declare the period over on its final day", async () => {
    // The regression: elapsedDays equalled periodDays on the last day, so pace
    // returned PERIOD_COMPLETE_MISSED and a null run rate, and the panel
    // printed "The period is over." while a full selling day remained --
    // suppressing the only actionable number that day has.
    vi.setSystemTime(new Date("2026-09-30T08:00:00Z"));
    seed({
      achieved: [
        {
          date: "2026-09-05",
          platform: "ONLYFANS",
          imported_at: "2026-09-06T00:00:00+00:00",
          data_confidence: "MEASURED",
          creator_platform_receipts: 20_000,
        },
      ],
    });
    const result = await buildCreatorRevenuePlan(session, CREATOR, {
      ...request,
      // $30k target against $20k achieved: a real shortfall, not a met target.
      targetRevenue: 30_000,
      baselineType: "ROLLING_30D",
    });
    expect(result.pace.status).not.toBe("PERIOD_COMPLETE_MISSED");
    // One day remains, and it has to deliver the whole $10,000 shortfall.
    expect(result.pace.requiredDailyRunRate).toBe(10_000);
  });

  it("does not report a creator exactly on pace as behind on day one", async () => {
    // Nothing has been earned because no day has finished, so nothing is owed.
    vi.setSystemTime(new Date("2026-09-01T08:00:00Z"));
    seed({ achieved: [] });
    const result = await buildCreatorRevenuePlan(session, CREATOR, {
      ...request,
      baselineType: "ROLLING_30D",
    });
    expect(result.pace.expectedByNow).toBe(0);
    expect(result.pace.status).toBe("ON_TRACK");
  });

  it("treats a period entirely in the future as not yet started", async () => {
    seed();
    const result = await buildCreatorRevenuePlan(session, CREATOR, {
      targetRevenue: 10_000,
      periodStart: "2026-12-01",
      periodEnd: "2026-12-31",
      baselineType: "ROLLING_30D",
    });
    expect(result.pace.elapsedFraction).toBe(0);
    // Nothing is expected yet, so nothing can be behind.
    expect(result.pace.expectedByNow).toBe(0);
  });

  it("treats a period entirely in the past as fully elapsed", async () => {
    seed();
    const result = await buildCreatorRevenuePlan(session, CREATOR, {
      targetRevenue: 10_000,
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      baselineType: "ROLLING_30D",
    });
    expect(result.pace.elapsedFraction).toBe(1);
    // No days remain, so there is no run rate that reaches the target.
    expect(result.pace.requiredDailyRunRate).toBeNull();
  });
});

describe("provenance survives into the plan", () => {
  it("refuses the stages the baseline never measured", async () => {
    // The state of every creator whose social data predates ingestion.
    seed({
      metrics: {
        ...measured,
        reach: 0,
        profileVisits: 0,
        outboundClicks: 0,
        unmeasuredDimensions: ["reach", "profileVisits", "outboundClicks"],
      },
    });
    const result = await buildCreatorRevenuePlan(session, CREATOR, {
      ...request,
      baselineType: "ROLLING_30D",
    });
    expect(result.plan.complete).toBe(false);
    expect(result.plan.unplannable).toEqual(expect.arrayContaining(["reach"]));
    // ...while the measurable half still produces real numbers.
    expect(result.plan.stages.find((s) => s.stage === "firstBuyers")?.required).toBe(100);
  });

  it("reports UNKNOWN confidence when the period holds no measured rows", async () => {
    // Not MEASURED by default: with nothing to qualify the figures, the honest
    // answer is that we do not know how good they are.
    seed({ achieved: [] });
    const result = await buildCreatorRevenuePlan(session, CREATOR, {
      ...request,
      baselineType: "ROLLING_30D",
    });
    for (const stage of result.plan.stages) expect(stage.confidence).toBe("UNKNOWN");
  });
});
