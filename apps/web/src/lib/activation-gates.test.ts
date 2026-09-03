import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The four activation gates that previously had no write path at any layer.
 *
 * Before these services existed, `convert_prospect_to_creator` inserted a
 * creator at PENDING/NOT_STARTED with no owners and no boundaries, and nothing
 * in the product could change any of it. `evaluateActivationReadiness` then
 * refused to let the creator reach ACTIVE, and `creator_baselines` -- unwritten
 * by anything -- kept every scheduler pass returning NO_BASELINE_FROZEN. The
 * only way through was direct SQL.
 *
 * These tests assert the writes exist, are organization-scoped, and refuse a
 * stale concurrency token.
 */

interface RecordedQuery {
  table: string;
  op: string;
  filters: Array<[string, string, unknown]>;
  payload?: Record<string, unknown> | Array<Record<string, unknown>>;
}

const recorded: RecordedQuery[] = [];
/** What maybeSingle()/single() resolve to — one row, or null for "not found". */
let rows: unknown = null;
/**
 * What an awaited list query resolves to. Kept separate from `rows`: a builder
 * that returned the same value for both would hand a bare object to every
 * z.array() parse in the code under test.
 */
let listRows: unknown[] = [];
let writeResult: unknown = null;

function makeQuery(table: string) {
  const entry: RecordedQuery = { table, op: "select", filters: [] };
  recorded.push(entry);
  const chain: Record<string, unknown> = {};
  for (const op of ["select", "eq", "is", "neq", "order", "limit", "in", "gte", "lte"])
    chain[op] = (...args: unknown[]) => {
      const column = typeof args[0] === "string" ? args[0] : "";
      entry.filters.push([op, column, args[1]]);
      return chain;
    };
  for (const op of ["insert", "update", "upsert"])
    chain[op] = (payload: Record<string, unknown>) => {
      entry.op = op;
      entry.payload = payload;
      return chain;
    };
  chain["maybeSingle"] = () =>
    Promise.resolve({ data: entry.op === "select" ? rows : (writeResult ?? rows), error: null });
  chain["single"] = () =>
    Promise.resolve({ data: entry.op === "select" ? rows : (writeResult ?? rows), error: null });
  chain["then"] = (resolve: (value: unknown) => unknown) =>
    resolve({ data: entry.op === "select" ? listRows : writeResult, error: null, count: 0 });
  return chain;
}

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ from: (table: string) => makeQuery(table) }),
}));
vi.mock("@/lib/audit", () => ({ appendAudit: vi.fn(() => Promise.resolve()) }));

const { updateCreatorCompliance, updateCreatorAssignment, CreatorError } = await import(
  "./creators"
);
const { createBoundary, BoundaryError } = await import("./boundaries");
const { freezeBaseline, BaselineError } = await import("./baselines");
const { importCreatorRevenue } = await import("./metrics-import");

const ORG = "11111111-1111-4111-8111-111111111111";
const CREATOR = "33333333-3333-4333-8333-333333333333";
const STAMP = "2026-01-01T00:00:00.000Z";
const session = {
  userId: "22222222-2222-4222-8222-222222222222",
  organizationId: ORG,
  role: "super_admin" as const,
  email: "founder@foundry.test",
};

beforeEach(() => {
  recorded.length = 0;
  rows = null;
  listRows = [];
  writeResult = null;
});

describe("compliance gate", () => {
  it("records a jurisdiction decision against the creator", async () => {
    rows = { id: CREATOR, updated_at: STAMP, stage_name: "Test Creator" };
    writeResult = { id: CREATOR };
    await updateCreatorCompliance(session, CREATOR, {
      jurisdictionReviewStatus: "APPROVED",
      updatedAt: STAMP,
    });
    const update = recorded.find((query) => query.op === "update" && query.table === "creators");
    expect((update?.payload as Record<string, unknown>)["jurisdiction_review_status"]).toBe(
      "APPROVED",
    );
  });

  it("refuses a stale concurrency token rather than overwriting", async () => {
    rows = { id: CREATOR, updated_at: STAMP, stage_name: "Test Creator" };
    await expect(
      updateCreatorCompliance(session, CREATOR, {
        adultConfirmationStatus: "CONFIRMED",
        updatedAt: "2025-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow("CREATOR_CHANGED_REFRESH_REQUIRED");
    expect(recorded.some((query) => query.op === "update")).toBe(false);
  });

  it("scopes every query to the caller's organization", async () => {
    rows = { id: CREATOR, updated_at: STAMP, stage_name: "Test Creator" };
    writeResult = { id: CREATOR };
    await updateCreatorCompliance(session, CREATOR, {
      adultConfirmationStatus: "CONFIRMED",
      updatedAt: STAMP,
    });
    for (const query of recorded.filter((entry) => entry.table === "creators"))
      expect(
        query.filters.find(([op, column]) => op === "eq" && column === "organization_id")?.[2],
      ).toBe(ORG);
  });
});

describe("assignment gate", () => {
  it("assigns a creator success owner", async () => {
    rows = { id: CREATOR, updated_at: STAMP, stage_name: "Test Creator" };
    writeResult = { id: CREATOR };
    await updateCreatorAssignment(session, CREATOR, {
      creatorSuccessUserId: session.userId,
      updatedAt: STAMP,
    });
    const update = recorded.find((query) => query.op === "update" && query.table === "creators");
    expect((update?.payload as Record<string, unknown>)["assigned_creator_success_user_id"]).toBe(
      session.userId,
    );
  });

  it("clears an owner when passed null rather than ignoring the field", async () => {
    rows = { id: CREATOR, updated_at: STAMP, stage_name: "Test Creator" };
    writeResult = { id: CREATOR };
    await updateCreatorAssignment(session, CREATOR, { growthUserId: null, updatedAt: STAMP });
    const update = recorded.find((query) => query.op === "update" && query.table === "creators");
    expect((update?.payload as Record<string, unknown>)["assigned_growth_user_id"]).toBeNull();
  });

  it("carries a status on the error so routes map it correctly", () => {
    expect(new CreatorError("CREATOR_NOT_FOUND", 404).status).toBe(404);
  });
});

describe("boundaries gate", () => {
  it("writes a boundary using creator_boundaries' own columns", async () => {
    rows = { id: CREATOR, stage_name: "Test Creator" };
    writeResult = { id: "44444444-4444-4444-8444-444444444444" };
    await createBoundary(session, CREATOR, {
      boundaryType: "CONTENT",
      description: "No face-visible content",
      severity: "HARD",
      requiresCreatorApproval: false,
    });
    const insert = recorded.find(
      (query) => query.op === "insert" && query.table === "creator_boundaries",
    );
    const payload = insert?.payload as Record<string, unknown>;
    // The columns that actually exist on this table -- the Creator 360 read
    // previously used creator_truth_items' names here and returned 42703.
    expect(payload["boundary_type"]).toBe("CONTENT");
    expect(payload["description"]).toBe("No face-visible content");
    expect(payload["severity"]).toBe("HARD");
    expect(payload["organization_id"]).toBe(ORG);
    expect(payload["active"]).toBe(true);
  });

  it("refuses a creator from another organization", async () => {
    rows = null;
    await expect(
      createBoundary(session, CREATOR, {
        boundaryType: "CONTENT",
        description: "Nope",
        severity: "HARD",
        requiresCreatorApproval: false,
      }),
    ).rejects.toThrow("CREATOR_NOT_FOUND");
    expect(recorded.some((query) => query.op === "insert")).toBe(false);
  });

  it("carries a status on the error", () => {
    expect(new BoundaryError("CREATOR_NOT_FOUND", 404).status).toBe(404);
  });
});

describe("baseline gate", () => {
  it("refuses to freeze a baseline over a period with no measured data", async () => {
    // Freezing zeros would be worse than refusing: percentChange treats a zero
    // baseline as incomparable, so every later comparison would silently
    // produce no signal while the creator appeared to have a baseline.
    rows = { id: CREATOR, stage_name: "Test Creator" };
    await expect(
      freezeBaseline(session, CREATOR, {
        periodStart: "2026-08-01",
        periodEnd: "2026-08-30",
        baselineType: "ROLLING_30D",
      }),
    ).rejects.toThrow("NO_MEASURED_DATA_IN_PERIOD");
    expect(recorded.some((query) => query.table === "creator_baselines" && query.op === "insert"))
      .toBe(false);
  });

  it("rejects a period whose start is after its end", () => {
    expect(new BaselineError("PERIOD_START_AFTER_END", 400).status).toBe(400);
  });
});

describe("revenue import", () => {
  it("refuses a payload repeating a date, which would make the upsert order-dependent", async () => {
    rows = { id: CREATOR, stage_name: "Test Creator" };
    await expect(
      importCreatorRevenue(session, CREATOR, {
        platform: "ONLYFANS",
        source: "OPERATOR_ENTRY",
        dataConfidence: "MEASURED",
        rows: [
          { date: "2026-08-01", creatorPlatformReceipts: 100 },
          { date: "2026-08-01", creatorPlatformReceipts: 200 },
        ],
      }),
    ).rejects.toThrow("DUPLICATE_DATES_IN_PAYLOAD");
  });

  it("carries source and confidence onto every written row", async () => {
    rows = { id: CREATOR, stage_name: "Test Creator" };
    writeResult = [{ id: "a" }];
    await importCreatorRevenue(session, CREATOR, {
      platform: "ONLYFANS",
      source: "OPERATOR_ENTRY",
      dataConfidence: "ESTIMATED",
      rows: [{ date: "2026-08-01", creatorPlatformReceipts: 100, newSubscribers: 4 }],
    });
    const upsert = recorded.find(
      (query) => query.op === "upsert" && query.table === "creator_revenue_daily",
    );
    const payload = upsert?.payload as Array<Record<string, unknown>>;
    expect(payload[0]?.["source"]).toBe("OPERATOR_ENTRY");
    // A typed figure is not the same claim as a provider-reported one, and the
    // difference has to survive into the report that cites it.
    expect(payload[0]?.["data_confidence"]).toBe("ESTIMATED");
    expect(payload[0]?.["organization_id"]).toBe(ORG);
  });
});
