import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@creatoros/domain";

/**
 * Drill F: an operator in organization B must not be able to reach organization
 * A's records through the agent, and must not be able to learn that a creator
 * exists there at all.
 *
 * The fake client records every filter applied to every query, so these assert
 * the real query shape rather than trusting that the tools "look" scoped.
 */

interface RecordedQuery {
  table: string;
  filters: Array<[string, string, unknown]>;
}

const recorded: RecordedQuery[] = [];
let rowsToReturn: unknown = null;

function makeQuery(table: string) {
  const entry: RecordedQuery = { table, filters: [] };
  recorded.push(entry);
  const chain: Record<string, unknown> = {};
  const record =
    (op: string) =>
    (...args: unknown[]) => {
      const column = typeof args[0] === "string" ? args[0] : "";
      entry.filters.push([op, column, args[1]]);
      return chain;
    };
  for (const op of [
    "select",
    "eq",
    "neq",
    "is",
    "or",
    "in",
    "gte",
    "lt",
    "order",
    "limit",
    "update",
    "insert",
    "upsert",
    "delete",
  ])
    chain[op] = record(op);
  chain["maybeSingle"] = () => Promise.resolve({ data: rowsToReturn, error: null });
  chain["single"] = () => Promise.resolve({ data: rowsToReturn, error: null });
  // Awaiting the builder itself resolves like a list query.
  chain["then"] = (resolve: (value: unknown) => unknown) =>
    resolve({ data: rowsToReturn ?? [], error: null });
  return chain;
}

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ from: (table: string) => makeQuery(table) }),
}));

const { executeAgentTool } = await import("./tools");

const ORG_B = "bbbbbbbb-2222-4222-8222-222222222222";
const CREATOR_IN_ORG_A = "aaaaaaaa-1111-4111-8111-111111111111";

function orgBContext(role: Role = "super_admin") {
  return {
    session: {
      userId: "cccccccc-3333-4333-8333-333333333333",
      organizationId: ORG_B,
      role,
      email: "adversary@other.test",
    },
    correlationId: "corr-drill-f",
    creatorFacingSurface: false,
  };
}

beforeEach(() => {
  recorded.length = 0;
  rowsToReturn = null;
});

describe("Drill F — organization B asks the agent about an organization A creator", () => {
  it("refuses with CREATOR_NOT_FOUND rather than confirming the creator exists", async () => {
    // The creator lookup is scoped to org B, so an org A id returns no row.
    rowsToReturn = null;
    await expect(
      executeAgentTool(orgBContext(), "get_creator_summary", { creatorId: CREATOR_IN_ORG_A }),
    ).rejects.toThrow("CREATOR_NOT_FOUND");
  });

  it("scopes the creator lookup to the caller's organization, not one from the request", async () => {
    rowsToReturn = null;
    await executeAgentTool(orgBContext(), "get_creator_summary", {
      creatorId: CREATOR_IN_ORG_A,
    }).catch(() => undefined);
    const creatorQuery = recorded.find((query) => query.table === "creators");
    expect(creatorQuery).toBeDefined();
    const orgFilter = creatorQuery?.filters.find(
      ([op, column]) => op === "eq" && column === "organization_id",
    );
    expect(orgFilter?.[2]).toBe(ORG_B);
  });

  for (const tool of [
    "get_creator_summary",
    "get_creator_metrics",
    "get_creator_tasks",
    "get_creator_reports",
    "get_creator_experiments",
  ]) {
    it(`refuses ${tool} for a creator outside the caller's organization`, async () => {
      rowsToReturn = null;
      await expect(
        executeAgentTool(orgBContext(), tool, { creatorId: CREATOR_IN_ORG_A }),
      ).rejects.toThrow("CREATOR_NOT_FOUND");
      // Every query issued before the refusal was org-scoped.
      for (const query of recorded.filter((entry) => entry.table === "creators")) {
        const filter = query.filters.find(
          ([op, column]) => op === "eq" && column === "organization_id",
        );
        expect(filter?.[2]).toBe(ORG_B);
      }
    });
  }

  it("scopes search to the caller's organization so it cannot enumerate another tenant", async () => {
    rowsToReturn = [];
    await executeAgentTool(orgBContext(), "search_creator", { query: "Madison" });
    const search = recorded.find((query) => query.table === "creators");
    const orgFilter = search?.filters.find(
      ([op, column]) => op === "eq" && column === "organization_id",
    );
    expect(orgFilter?.[2]).toBe(ORG_B);
  });

  it("scopes portfolio alerts to the caller's organization on every table it reads", async () => {
    rowsToReturn = [];
    await executeAgentTool(orgBContext(), "get_portfolio_alerts", {});
    const tables = recorded.map((query) => query.table);
    expect(tables).toEqual(expect.arrayContaining(["incidents", "creators", "tasks"]));
    for (const query of recorded) {
      const orgFilter = query.filters.find(
        ([op, column]) => op === "eq" && column === "organization_id",
      );
      expect(orgFilter, `${query.table} was queried without an organization filter`).toBeDefined();
      expect(orgFilter?.[2]).toBe(ORG_B);
    }
  });

  it("writes into the caller's organization even when a foreign creator is named", async () => {
    rowsToReturn = null;
    await executeAgentTool(orgBContext(), "create_internal_task", {
      creatorId: CREATOR_IN_ORG_A,
      title: "Reach into another tenant",
    }).catch(() => undefined);
    // The creator guard runs first, so the write never happens for a foreign id.
    expect(recorded.some((query) => query.table === "tasks")).toBe(false);
  });

  it("scopes an incident acknowledgement to the caller's organization", async () => {
    rowsToReturn = null;
    await executeAgentTool(orgBContext(), "acknowledge_alert", {
      incidentId: "dddddddd-4444-4444-8444-444444444444",
    }).catch(() => undefined);
    const incident = recorded.find((query) => query.table === "incidents");
    const orgFilter = incident?.filters.find(
      ([op, column]) => op === "eq" && column === "organization_id",
    );
    expect(orgFilter?.[2]).toBe(ORG_B);
  });
});
