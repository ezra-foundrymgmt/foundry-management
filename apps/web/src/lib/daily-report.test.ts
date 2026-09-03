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

function makeQuery(table: string) {
  const chain: Record<string, unknown> = {};
  const result = () => Promise.resolve(tables.get(table) ?? { data: null, error: null });
  for (const op of ["select", "eq", "gte", "order", "limit", "in", "is"]) chain[op] = () => chain;
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
  tables.set("creators", {
    data: { id: CREATOR, stage_name: "Madison Carter", current_health_score: 71 },
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
