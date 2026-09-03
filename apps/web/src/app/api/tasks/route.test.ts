import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The task list must name whoever owns a task.
 *
 * It previously rendered the literal string "Assigned user" for every owned
 * task, so a list of owned work was indistinguishable from a list of
 * anonymous work -- the exact ambiguity task ownership exists to remove.
 *
 * This exercises the handler for real rather than typechecking it: the first
 * version of the fix referenced the owner-name map inside the row mapping
 * before the map was declared. TypeScript accepts that (the reference is
 * inside a closure) and it throws at runtime.
 */
const tables = new Map<string, { data: unknown; error: null | { message: string } }>();

function makeQuery(table: string) {
  const chain: Record<string, unknown> = {};
  const result = () => Promise.resolve(tables.get(table) ?? { data: [], error: null });
  for (const op of ["select", "eq", "order", "limit", "in", "is"]) chain[op] = () => chain;
  chain["then"] = (resolve: (value: unknown) => unknown) => resolve(result());
  return chain;
}

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ from: (table: string) => makeQuery(table) }),
}));
vi.mock("@/lib/auth", () => ({
  AuthorizationError: class extends Error {
    status = 403;
  },
  requirePermission: () =>
    Promise.resolve({
      userId: "11111111-1111-4111-8111-111111111111",
      organizationId: "22222222-2222-4222-8222-222222222222",
      role: "super_admin",
      email: "founder@foundry.test",
    }),
}));

const { GET } = await import("./route");

const OWNER = "99999999-9999-4999-8999-999999999999";

beforeEach(() => {
  tables.clear();
  tables.set("creators", { data: [], error: null });
});

describe("task list ownership", () => {
  it("names the owner of an owned task", async () => {
    tables.set("tasks", {
      data: [
        {
          id: "aaaaaaaa-1111-4111-8111-111111111111",
          creator_id: null,
          title: "Collect baseline metrics",
          department: "Growth",
          priority: "HIGH",
          status: "OPEN",
          owner_user_id: OWNER,
          due_at: null,
          source_type: "MANUAL",
          source_id: null,
          updated_at: "2026-01-01T00:00:00+00:00",
        },
      ],
      error: null,
    });
    tables.set("users", {
      data: [{ id: OWNER, display_name: "Payton", email: "payton@foundrymgmt.net" }],
      error: null,
    });

    const response = await GET();
    const body = (await response.json()) as { data: Array<{ owner: string; ownerUserId: string }> };

    expect(response.status).toBe(200);
    expect(body.data[0]?.owner).toBe("Payton");
    expect(body.data[0]?.ownerUserId).toBe(OWNER);
  });

  it("says Unassigned rather than inventing an owner", async () => {
    tables.set("tasks", {
      data: [
        {
          id: "bbbbbbbb-2222-4222-8222-222222222222",
          creator_id: null,
          title: "Unowned work",
          department: "Operations",
          priority: "MEDIUM",
          status: "OPEN",
          owner_user_id: null,
          due_at: null,
          source_type: "MANUAL",
          source_id: null,
          updated_at: "2026-01-01T00:00:00+00:00",
        },
      ],
      error: null,
    });

    const response = await GET();
    const body = (await response.json()) as { data: Array<{ owner: string }> };
    expect(body.data[0]?.owner).toBe("Unassigned");
  });
});
