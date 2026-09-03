import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The fake records every filter and payload so these assert the real query
 * shape — that ownership comes from the session and never from the request.
 */
interface RecordedQuery {
  table: string;
  op: string;
  filters: Array<[string, string, unknown]>;
  payload?: Record<string, unknown>;
}

const recorded: RecordedQuery[] = [];
let rows: unknown = null;
let insertResult: unknown = null;

function makeQuery(table: string) {
  const entry: RecordedQuery = { table, op: "select", filters: [] };
  recorded.push(entry);
  const chain: Record<string, unknown> = {};
  for (const op of ["select", "eq", "is", "neq", "order", "limit", "in"])
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
  chain["maybeSingle"] = () => Promise.resolve({ data: insertResult ?? rows, error: null });
  chain["single"] = () => Promise.resolve({ data: insertResult ?? rows, error: null });
  chain["then"] = (resolve: (value: unknown) => unknown) =>
    resolve({ data: rows ?? [], error: null });
  return chain;
}

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ from: (table: string) => makeQuery(table) }),
}));
vi.mock("@/lib/audit", () => ({ appendAudit: vi.fn(() => Promise.resolve()) }));

const {
  createProspect,
  updateProspect,
  ProspectError,
  prospectCreateSchema,
  prospectUpdateSchema,
} = await import("./prospects");

const ORG = "11111111-1111-4111-8111-111111111111";
const session = {
  userId: "22222222-2222-4222-8222-222222222222",
  organizationId: ORG,
  role: "growth" as const,
  email: "growth@foundry.test",
};

beforeEach(() => {
  recorded.length = 0;
  rows = [];
  insertResult = null;
});

describe("prospect input validation", () => {
  it("requires a name and rejects an oversized note", () => {
    expect(prospectCreateSchema.safeParse({}).success).toBe(false);
    expect(
      prospectCreateSchema.safeParse({
        preferredName: "Madison",
        stageName: "Madison Carter",
        opportunityNotes: "x".repeat(5000),
      }).success,
    ).toBe(false);
  });

  it("rejects an empty update rather than issuing a no-op write", () => {
    expect(prospectUpdateSchema.safeParse({}).success).toBe(false);
  });

  it("only accepts a pipeline stage from the canonical list", () => {
    const updatedAt = "2026-01-01T00:00:00.000Z";
    expect(
      prospectUpdateSchema.safeParse({ pipelineStage: "SIGNED", updatedAt }).success,
    ).toBe(true);
    expect(
      prospectUpdateSchema.safeParse({ pipelineStage: "MADE_UP", updatedAt }).success,
    ).toBe(false);
  });

  it("requires an updatedAt concurrency token even when a field is present", () => {
    expect(prospectUpdateSchema.safeParse({ pipelineStage: "SIGNED" }).success).toBe(false);
  });
});

describe("duplicate prevention", () => {
  it("refuses a second prospect with the same email", async () => {
    rows = [
      {
        id: "a",
        stage_name: "Someone Else",
        email: "madison@example.test",
        prospect_number: "PR-000001",
      },
    ];
    await expect(
      createProspect(session, {
        preferredName: "Madison",
        stageName: "Madison Carter",
        email: "MADISON@example.test",
      }),
    ).rejects.toThrow("DUPLICATE_PROSPECT:PR-000001");
  });

  it("refuses a near-duplicate stage name differing only by case or punctuation", async () => {
    rows = [{ id: "a", stage_name: "Madison Carter", email: null, prospect_number: "PR-000002" }];
    for (const stageName of ["madison carter", "Madison  Carter", "Madison-Carter"])
      await expect(
        createProspect(session, { preferredName: "Madison", stageName }),
      ).rejects.toThrow("DUPLICATE_PROSPECT:PR-000002");
  });

  it("allows a genuinely different prospect", async () => {
    rows = [{ id: "a", stage_name: "Madison Carter", email: null, prospect_number: "PR-000002" }];
    insertResult = { id: "new", prospect_number: "PR-000003" };
    await expect(
      createProspect(session, { preferredName: "Ava", stageName: "Ava Monroe" }),
    ).resolves.toMatchObject({ prospect_number: "PR-000003" });
  });

  it("scopes the duplicate search to the caller's organization", async () => {
    rows = [];
    insertResult = { id: "new", prospect_number: "PR-000003" };
    await createProspect(session, { preferredName: "Ava", stageName: "Ava Monroe" });
    const lookup = recorded.find((query) => query.table === "prospects" && query.op === "select");
    expect(
      lookup?.filters.find(([op, column]) => op === "eq" && column === "organization_id")?.[2],
    ).toBe(ORG);
  });

  it("writes the new prospect into the caller's organization", async () => {
    rows = [];
    insertResult = { id: "new", prospect_number: "PR-000003" };
    await createProspect(session, { preferredName: "Ava", stageName: "Ava Monroe" });
    const insert = recorded.find((query) => query.op === "insert" && query.table === "prospects");
    expect(insert?.payload?.["organization_id"]).toBe(ORG);
    // Stage is always the entry stage; a caller cannot inject one.
    expect(insert?.payload?.["pipeline_stage"]).toBe("SOURCED");
  });
});

describe("prospect updates", () => {
  it("refuses a prospect that does not belong to the caller's organization", async () => {
    rows = null;
    await expect(
      updateProspect(session, "33333333-3333-4333-8333-333333333333", {
        pipelineStage: "AUDIT",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow("PROSPECT_NOT_FOUND");
  });

  it("refuses an update against a stale updatedAt instead of silently overwriting a concurrent change", async () => {
    // Regression: updateProspect had no optimistic-concurrency check at all --
    // two operators moving the same card from a stale board both won
    // silently, one clobbering the other with no signal anything was lost.
    rows = {
      id: "p1",
      pipeline_stage: "FOLLOW_UP",
      prospect_number: "PR-000001",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    await expect(
      updateProspect(session, "33333333-3333-4333-8333-333333333333", {
        pipelineStage: "AUDIT",
        updatedAt: "2025-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow("PROSPECT_CHANGED_REFRESH_REQUIRED");
    expect(recorded.some((query) => query.op === "update")).toBe(false);
  });

  it("scopes both the ownership check and the update to the caller's organization", async () => {
    rows = {
      id: "p1",
      pipeline_stage: "FOLLOW_UP",
      prospect_number: "PR-000001",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    insertResult = null;
    await updateProspect(session, "33333333-3333-4333-8333-333333333333", {
      pipelineStage: "AUDIT",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }).catch(() => undefined);
    for (const query of recorded.filter((entry) => entry.table === "prospects"))
      expect(
        query.filters.find(([op, column]) => op === "eq" && column === "organization_id")?.[2],
      ).toBe(ORG);
  });

  it("archives by stamping archived_at rather than deleting the record", async () => {
    rows = {
      id: "p1",
      pipeline_stage: "FOLLOW_UP",
      prospect_number: "PR-000001",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    await updateProspect(session, "33333333-3333-4333-8333-333333333333", {
      archived: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    }).catch(() => undefined);
    const update = recorded.find((query) => query.op === "update" && query.table === "prospects");
    expect(update?.payload?.["archived_at"]).toBeTruthy();
    expect(recorded.some((query) => query.op === "delete")).toBe(false);
  });

  it("records a stage change on the activity timeline", async () => {
    rows = {
      id: "p1",
      pipeline_stage: "FOLLOW_UP",
      prospect_number: "PR-000001",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    await updateProspect(session, "33333333-3333-4333-8333-333333333333", {
      pipelineStage: "AUDIT",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }).catch(() => undefined);
    const activity = recorded.find((query) => query.table === "prospect_activities");
    expect(activity?.payload?.["activity_type"]).toBe("STAGE_CHANGE");
    expect(activity?.payload?.["body"]).toBe("FOLLOW_UP → AUDIT");
    expect(activity?.payload?.["created_by"]).toBe(session.userId);
  });

  it("does not log a stage change when the stage did not change", async () => {
    rows = {
      id: "p1",
      pipeline_stage: "AUDIT",
      prospect_number: "PR-000001",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    await updateProspect(session, "33333333-3333-4333-8333-333333333333", {
      pipelineStage: "AUDIT",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }).catch(() => undefined);
    expect(recorded.some((query) => query.table === "prospect_activities")).toBe(false);
  });

  it("carries a status on the error so routes map it to the right response", () => {
    expect(new ProspectError("PROSPECT_NOT_FOUND", 404).status).toBe(404);
  });
});
