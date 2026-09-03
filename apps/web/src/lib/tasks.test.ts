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
  chain["then"] = (resolve: (value: unknown) => unknown) =>
    resolve({ data: rows ?? [], error: queryError });
  return chain;
}

const appendAudit = vi.fn(() => Promise.resolve());
const logEvent = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ from: (table: string) => makeQuery(table) }),
}));
vi.mock("@/lib/audit", () => ({ appendAudit: (...args: unknown[]) => appendAudit(...(args as [])) }));
vi.mock("@/lib/observability", () => ({ logEvent: (...args: unknown[]) => logEvent(...(args as [])) }));

const { createTask, updateTaskPriority, TaskError, taskCreateSchema, taskPrioritySchema } =
  await import("./tasks");

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const CREATOR = "20000000-0000-4000-8000-000000000001";
const TASK = "40000000-0000-4000-8000-000000000001";
const NOW = "2026-09-03T12:00:00.000Z";

const session = {
  userId: "22222222-2222-4222-8222-222222222222",
  organizationId: ORG,
  role: "super_admin" as const,
  email: "ezra@foundrymgmt.net",
};

beforeEach(() => {
  recorded.length = 0;
  rows = [];
  singleResult = null;
  queryError = null;
  appendAudit.mockClear();
  logEvent.mockClear();
});

describe("task input validation", () => {
  it("requires a title, a known department and a known priority", () => {
    expect(taskCreateSchema.safeParse({}).success).toBe(false);
    expect(
      taskCreateSchema.safeParse({ title: "Ship it", department: "Growth", priority: "HIGH" })
        .success,
    ).toBe(true);
    expect(
      taskCreateSchema.safeParse({ title: "Ship it", department: "Marketing", priority: "HIGH" })
        .success,
    ).toBe(false);
    expect(
      taskCreateSchema.safeParse({ title: "Ship it", department: "Growth", priority: "URGENT" })
        .success,
    ).toBe(false);
  });

  it("rejects an empty title and an oversized one", () => {
    const base = { department: "Growth", priority: "HIGH" };
    expect(taskCreateSchema.safeParse({ ...base, title: "   " }).success).toBe(false);
    expect(taskCreateSchema.safeParse({ ...base, title: "x".repeat(501) }).success).toBe(false);
  });

  it("requires the concurrency token on a priority change", () => {
    expect(taskPrioritySchema.safeParse({ priority: "HIGH" }).success).toBe(false);
    expect(taskPrioritySchema.safeParse({ priority: "HIGH", updatedAt: NOW }).success).toBe(true);
  });

  /**
   * Caught live, not by this suite: PostgREST always serializes timestamptz
   * with a numeric offset, never a bare Z. z.string().datetime() defaults to
   * rejecting exactly that form, so a real PATCH 400'd against staging
   * Supabase even though the fake-client tests here all passed, because the
   * NOW fixture above happens to already end in Z.
   */
  it("accepts the numeric-offset timestamp PostgREST actually returns, not just a bare Z", () => {
    expect(
      taskPrioritySchema.safeParse({
        priority: "HIGH",
        updatedAt: "2026-09-03T13:52:10.248131+00:00",
      }).success,
    ).toBe(true);
  });
});

describe("createTask", () => {
  it("writes the caller's organization and attributes the request to the caller", async () => {
    singleResult = { id: TASK, title: "Ship it", priority: "HIGH" };
    await createTask(session, { title: "Ship it", department: "Growth", priority: "HIGH" });

    const insert = recorded.find((entry) => entry.op === "insert");
    expect(insert?.table).toBe("tasks");
    expect(insert?.payload).toMatchObject({
      organization_id: ORG,
      requested_by: session.userId,
      status: "OPEN",
      source_type: "MANUAL",
      priority: "HIGH",
      creator_id: null,
    });
  });

  it("attributes the audit entry to the session, not the request", async () => {
    singleResult = { id: TASK, title: "Ship it", priority: "HIGH" };
    await createTask(session, { title: "Ship it", department: "Growth", priority: "HIGH" });
    expect(appendAudit).toHaveBeenCalledWith(
      session,
      "task.created",
      "task",
      TASK,
      expect.objectContaining({ priority: "HIGH", department: "Growth" }),
    );
  });

  it("proves a supplied creator belongs to the caller's organization before attaching it", async () => {
    singleResult = { id: CREATOR };
    await createTask(session, {
      title: "Ship it",
      department: "Growth",
      priority: "HIGH",
      creatorId: CREATOR,
    });
    const lookup = recorded.find((entry) => entry.table === "creators");
    expect(lookup?.filters).toEqual(
      expect.arrayContaining([
        ["eq", "organization_id", ORG],
        ["eq", "id", CREATOR],
      ]),
    );
  });

  /**
   * The insert and the audit-log write are two independent network calls. If
   * the audit insert fails after the task already committed, the caller must
   * still see the created task — a 500 here would be a lie (the row exists)
   * and would hide the new id the caller needs. The failure is logged instead.
   */
  it("does not fail the caller's request when the audit write fails after a successful insert", async () => {
    singleResult = { id: TASK, title: "Ship it", priority: "HIGH" };
    appendAudit.mockRejectedValueOnce(new Error("audit_events insert failed"));
    const result = await createTask(session, {
      title: "Ship it",
      department: "Growth",
      priority: "HIGH",
    });
    expect(result).toMatchObject({ id: TASK, title: "Ship it", priority: "HIGH" });
    expect(logEvent).toHaveBeenCalledWith(
      "error",
      "task.audit_failed",
      expect.objectContaining({ action: "task.created", resourceId: TASK, userId: session.userId }),
    );
  });

  it("refuses a creator from another tenant rather than silently attaching it", async () => {
    singleResult = null; // the org-scoped lookup finds nothing
    await expect(
      createTask(session, {
        title: "Ship it",
        department: "Growth",
        priority: "HIGH",
        creatorId: CREATOR,
      }),
    ).rejects.toThrow("CREATOR_NOT_FOUND");
    expect(recorded.some((entry) => entry.op === "insert")).toBe(false);
    expect(appendAudit).not.toHaveBeenCalled();
  });

  it("never puts a driver message in the error the caller sees", async () => {
    queryError = { message: 'relation "public.tasks" does not exist' };
    await expect(
      createTask(session, { title: "Ship it", department: "Growth", priority: "HIGH" }),
    ).rejects.toThrow("TASK_DATABASE_FAILED");
    expect(logEvent).toHaveBeenCalledWith(
      "error",
      "task.database_failed",
      expect.objectContaining({ message: 'relation "public.tasks" does not exist' }),
    );
  });
});

describe("updateTaskPriority", () => {
  it("scopes the lookup to the session organization", async () => {
    singleResult = { id: TASK, priority: "LOW", updated_at: NOW };
    await updateTaskPriority(session, TASK, { priority: "CRITICAL", updatedAt: NOW });
    const lookup = recorded.find((entry) => entry.table === "tasks" && entry.op === "select");
    expect(lookup?.filters).toEqual(
      expect.arrayContaining([
        ["eq", "organization_id", ORG],
        ["eq", "id", TASK],
      ]),
    );
  });

  it("records the before and after value in the audit entry", async () => {
    singleResult = { id: TASK, priority: "LOW", updated_at: NOW };
    await updateTaskPriority(session, TASK, { priority: "CRITICAL", updatedAt: NOW });
    expect(appendAudit).toHaveBeenCalledWith(session, "task.priority.changed", "task", TASK, {
      before: "LOW",
      after: "CRITICAL",
    });
  });

  it("refuses a stale write rather than letting the later one silently win", async () => {
    singleResult = { id: TASK, priority: "LOW", updated_at: "2026-09-03T13:00:00.000Z" };
    await expect(
      updateTaskPriority(session, TASK, { priority: "CRITICAL", updatedAt: NOW }),
    ).rejects.toThrow("TASK_CHANGED_REFRESH_REQUIRED");
    expect(recorded.some((entry) => entry.op === "update")).toBe(false);
    expect(appendAudit).not.toHaveBeenCalled();
  });

  it("does not fail the caller's request when the audit write fails after a successful update", async () => {
    singleResult = { id: TASK, priority: "LOW", updated_at: NOW };
    appendAudit.mockRejectedValueOnce(new Error("audit_events insert failed"));
    const result = await updateTaskPriority(session, TASK, {
      priority: "CRITICAL",
      updatedAt: NOW,
    });
    expect(result).toEqual({ id: TASK, priority: "CRITICAL", updatedAt: expect.any(String) });
    expect(logEvent).toHaveBeenCalledWith(
      "error",
      "task.audit_failed",
      expect.objectContaining({
        action: "task.priority.changed",
        resourceId: TASK,
        userId: session.userId,
      }),
    );
  });

  it("reports a missing task without disclosing whether it exists in another tenant", async () => {
    singleResult = null;
    const error = await updateTaskPriority(session, TASK, {
      priority: "CRITICAL",
      updatedAt: NOW,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TaskError);
    expect((error as InstanceType<typeof TaskError>).status).toBe(404);
    expect((error as Error).message).toBe("TASK_NOT_FOUND");
  });

  it("carries the concurrency token into the update filter, not just the precheck", async () => {
    singleResult = { id: TASK, priority: "LOW", updated_at: NOW };
    await updateTaskPriority(session, TASK, { priority: "CRITICAL", updatedAt: NOW });
    const update = recorded.find((entry) => entry.op === "update");
    expect(update?.filters).toEqual(expect.arrayContaining([["eq", "updated_at", NOW]]));
  });

  it("does not accept a task id from another organization's session", async () => {
    singleResult = { id: TASK, priority: "LOW", updated_at: NOW };
    await updateTaskPriority({ ...session, organizationId: OTHER_ORG }, TASK, {
      priority: "CRITICAL",
      updatedAt: NOW,
    });
    for (const entry of recorded)
      expect(entry.filters).toEqual(
        expect.arrayContaining([["eq", "organization_id", OTHER_ORG]]),
      );
  });
});
