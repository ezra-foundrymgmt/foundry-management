import { beforeEach, describe, expect, it, vi } from "vitest";

interface RecordedQuery {
  table: string;
  op: string;
  filters: Array<[string, string, unknown]>;
  payload?: Record<string, unknown>;
}

const recorded: RecordedQuery[] = [];
let singleResult: unknown = null;
let queryError: { message: string } | null = null;

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
  chain["maybeSingle"] = () => Promise.resolve({ data: singleResult, error: queryError });
  chain["single"] = () => Promise.resolve({ data: singleResult, error: queryError });
  return chain;
}

const appendAudit = vi.fn(() => Promise.resolve());
const logEvent = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ from: (table: string) => makeQuery(table) }),
}));
vi.mock("@/lib/audit", () => ({ appendAudit: (...args: unknown[]) => appendAudit(...(args as [])) }));
vi.mock("@/lib/observability", () => ({ logEvent: (...args: unknown[]) => logEvent(...(args as [])) }));

const { updateCreatorPriority, CreatorError, creatorPrioritySchema } = await import("./creators");

const ORG = "11111111-1111-4111-8111-111111111111";
const MADISON = "20000000-0000-4000-8000-000000000001";
const NOW = "2026-09-03T12:00:00.000Z";

const ezra = {
  userId: "3c545be6-213a-4703-b032-2b023d85edfa",
  organizationId: ORG,
  role: "super_admin" as const,
  email: "ezra@foundrymgmt.net",
};

beforeEach(() => {
  recorded.length = 0;
  singleResult = null;
  queryError = null;
  appendAudit.mockClear();
  logEvent.mockClear();
});

describe("creator priority validation", () => {
  it("accepts the canonical ladder and null, and nothing else", () => {
    for (const priority of ["CRITICAL", "HIGH", "MEDIUM", "LOW", null])
      expect(creatorPrioritySchema.safeParse({ priority, updatedAt: NOW }).success).toBe(true);
    expect(creatorPrioritySchema.safeParse({ priority: "URGENT", updatedAt: NOW }).success).toBe(
      false,
    );
  });

  it("requires the concurrency token", () => {
    expect(creatorPrioritySchema.safeParse({ priority: "HIGH" }).success).toBe(false);
  });

  /**
   * Caught live, not by this suite: PostgREST always serializes timestamptz
   * with a numeric offset, never a bare Z. z.string().datetime() defaults to
   * rejecting exactly that form, so every real PATCH 400'd against staging
   * Supabase even though every fake-client test here passed, because the NOW
   * fixture above happens to already end in Z.
   */
  it("accepts the numeric-offset timestamp PostgREST actually returns, not just a bare Z", () => {
    expect(
      creatorPrioritySchema.safeParse({
        priority: "HIGH",
        updatedAt: "2026-09-03T13:52:10.248131+00:00",
      }).success,
    ).toBe(true);
  });
});

describe("updateCreatorPriority", () => {
  it("scopes both the lookup and the write to the session organization", async () => {
    singleResult = { id: MADISON, priority: null, updated_at: NOW, stage_name: "Madison Carter" };
    await updateCreatorPriority(ezra, MADISON, { priority: "CRITICAL", updatedAt: NOW });
    expect(recorded.length).toBeGreaterThanOrEqual(2);
    for (const entry of recorded)
      expect(entry.filters).toEqual(
        expect.arrayContaining([
          ["eq", "organization_id", ORG],
          ["eq", "id", MADISON],
        ]),
      );
  });

  it("attributes the change to the acting session and records before and after", async () => {
    singleResult = { id: MADISON, priority: null, updated_at: NOW, stage_name: "Madison Carter" };
    await updateCreatorPriority(ezra, MADISON, { priority: "CRITICAL", updatedAt: NOW });
    expect(appendAudit).toHaveBeenCalledWith(ezra, "creator.priority.changed", "creator", MADISON, {
      stageName: "Madison Carter",
      before: null,
      after: "CRITICAL",
    });
  });

  it("stamps updated_by with the acting user", async () => {
    singleResult = { id: MADISON, priority: "LOW", updated_at: NOW, stage_name: "Madison Carter" };
    await updateCreatorPriority(ezra, MADISON, { priority: "HIGH", updatedAt: NOW });
    const update = recorded.find((entry) => entry.op === "update");
    expect(update?.payload).toMatchObject({ priority: "HIGH", updated_by: ezra.userId });
  });

  it("allows clearing the priority back to untriaged", async () => {
    singleResult = { id: MADISON, priority: "HIGH", updated_at: NOW, stage_name: "Madison Carter" };
    const result = await updateCreatorPriority(ezra, MADISON, { priority: null, updatedAt: NOW });
    expect(result.priority).toBeNull();
    const update = recorded.find((entry) => entry.op === "update");
    expect(update?.payload).toMatchObject({ priority: null });
  });

  it("refuses a stale write", async () => {
    singleResult = {
      id: MADISON,
      priority: "LOW",
      updated_at: "2026-09-03T13:00:00.000Z",
      stage_name: "Madison Carter",
    };
    await expect(
      updateCreatorPriority(ezra, MADISON, { priority: "CRITICAL", updatedAt: NOW }),
    ).rejects.toThrow("CREATOR_CHANGED_REFRESH_REQUIRED");
    expect(recorded.some((entry) => entry.op === "update")).toBe(false);
    expect(appendAudit).not.toHaveBeenCalled();
  });

  /**
   * The priority write and the audit-log write are two independent network
   * calls. If the audit insert fails after the priority change already
   * committed, the caller must still see success — a 500 here would be a lie
   * (the change did happen) and would invite a confusing retry. The failure is
   * logged instead, so it is discoverable without an audit_events row.
   */
  it("does not fail the caller's request when the audit write fails after a successful update", async () => {
    singleResult = { id: MADISON, priority: null, updated_at: NOW, stage_name: "Madison Carter" };
    appendAudit.mockRejectedValueOnce(new Error("audit_events insert failed"));
    const result = await updateCreatorPriority(ezra, MADISON, {
      priority: "CRITICAL",
      updatedAt: NOW,
    });
    expect(result).toEqual({ id: MADISON, priority: "CRITICAL", updatedAt: expect.any(String) });
    expect(logEvent).toHaveBeenCalledWith(
      "error",
      "creator.priority.audit_failed",
      expect.objectContaining({ creatorId: MADISON, userId: ezra.userId }),
    );
  });

  it("returns 404 for a creator outside the tenant rather than disclosing it exists", async () => {
    singleResult = null;
    const error = await updateCreatorPriority(ezra, MADISON, {
      priority: "CRITICAL",
      updatedAt: NOW,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CreatorError);
    expect((error as InstanceType<typeof CreatorError>).status).toBe(404);
    expect((error as Error).message).toBe("CREATOR_NOT_FOUND");
  });

  it("never puts a driver message in the error the caller sees", async () => {
    queryError = { message: 'column "priority" of relation "creators" does not exist' };
    await expect(
      updateCreatorPriority(ezra, MADISON, { priority: "CRITICAL", updatedAt: NOW }),
    ).rejects.toThrow("CREATOR_DATABASE_FAILED");
    expect(logEvent).toHaveBeenCalledWith(
      "error",
      "creator.database_failed",
      expect.objectContaining({
        message: 'column "priority" of relation "creators" does not exist',
      }),
    );
  });
});
