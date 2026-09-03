import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * In live mode the readers must fail loudly when the database is unreachable.
 *
 * The failure this guards against is the one that mattered: a page quietly
 * falling back to seed fixtures and showing Madison Carter and invented revenue
 * to an operator as though it were Foundry's real data. An error is recoverable;
 * confidently wrong data is not.
 */

let adminClient: unknown = null;

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => adminClient,
}));
vi.mock("@/lib/auth", () => ({
  getSession: () =>
    Promise.resolve({
      userId: "11111111-1111-4111-8111-111111111111",
      organizationId: "22222222-2222-4222-8222-222222222222",
      role: "super_admin",
      email: "founder@foundry.test",
    }),
}));

const liveData = await import("./live-data");

const READERS = [
  "getLiveCreators",
  "getLiveProspects",
  "getLiveAuditEvents",
  "getLiveWorkflowRuns",
  "getLivePnlRows",
  "getLiveTasks",
  "getLiveReports",
  "getLiveIncidents",
  "getLiveExperiments",
  "getLiveContentAssets",
  "getLiveApplications",
] as const;

beforeEach(() => {
  adminClient = null;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("live readers refuse to invent data", () => {
  it("exposes a reader for every page that previously rendered fixtures", () => {
    for (const reader of READERS)
      expect(typeof (liveData as Record<string, unknown>)[reader], reader).toBe("function");
  });

  it("throws rather than returning anything when the database is not configured", async () => {
    for (const reader of READERS) {
      const fn = (liveData as unknown as Record<string, () => Promise<unknown>>)[reader];
      // No silent empty array, no fixture: an unreachable database is an error.
      await expect(fn?.(), `${reader} must throw`).rejects.toThrow("LIVE_DATA_UNAVAILABLE");
    }
  });

  it("returns null for a creator the caller's organization does not own", async () => {
    // maybeSingle resolving to null is how a cross-tenant id looks.
    const chain: Record<string, unknown> = {};
    for (const op of ["select", "eq", "gte", "order", "limit", "in", "is"]) chain[op] = () => chain;
    chain["maybeSingle"] = () => Promise.resolve({ data: null, error: null });
    chain["then"] = (resolve: (value: unknown) => unknown) =>
      resolve({ data: [], error: null, count: 0 });
    adminClient = { from: () => chain };

    await expect(
      liveData.getLiveCreatorDetail("33333333-3333-4333-8333-333333333333"),
    ).resolves.toBeNull();
  });
});

/**
 * Every column a reader selects must actually exist on the table it selects from.
 *
 * Regression: getLiveCreatorDetail selected `category,statement,item_type` from
 * creator_boundaries. Those are creator_truth_items' columns; creator_boundaries
 * has boundary_type/description/severity. PostgREST answered 42703 for every
 * live creator, and because the boundaries result was one of five whose `error`
 * was never checked, it degraded silently to an empty list -- then, once the
 * error checks were added, to a 500 on the whole Creator 360 page.
 *
 * Asserting against the migration DDL rather than a hand-copied list is what
 * makes this a guard against the class of bug rather than the one instance.
 */
describe("selected columns exist on the tables they are selected from", () => {
  // The whole chain, not just the first migration: a column added by a later
  // `alter table ... add column` (creators.priority, in 202609030013) is just
  // as real as one declared in the original create.
  const migrationDir = join(process.cwd(), "../../supabase/migrations");
  const migration = readdirSync(migrationDir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(join(migrationDir, file), "utf8"))
    .join("\n");

  /**
   * Column names declared for one table in the create-table DDL.
   *
   * Scanned by index rather than matched by regex: column defaults in this
   * schema contain both parentheses and commas
   * (`default ('CR-'||lpad(nextval('creator_number_seq')::text, 6, '0'))`),
   * so the split has to be depth-aware, and a regex for it is easy to get
   * subtly wrong.
   */
  function columnsOf(table: string): Set<string> {
    const header = `create table public.${table} (`;
    const start = migration.indexOf(header);
    if (start === -1) throw new Error(`no DDL found for ${table}`);
    const body = migration.slice(start + header.length);
    const names = new Set<string>();
    let depth = 0;
    let current = "";
    for (const char of body) {
      if (char === "(") depth += 1;
      if (char === ")") {
        // depth 0 here is the closing paren of the create-table itself.
        if (depth === 0) break;
        depth -= 1;
      }
      if (char === "," && depth === 0) {
        names.add(current.trim().split(/\s+/)[0] ?? "");
        current = "";
        continue;
      }
      current += char;
    }
    names.add(current.trim().split(/\s+/)[0] ?? "");

    // Columns added by later migrations. The statement spans lines
    // (`alter table public.creators\n  add column if not exists priority text;`)
    // so this reads the whole statement up to its terminating semicolon.
    const alterHeader = `alter table public.${table}`;
    let cursor = migration.indexOf(alterHeader);
    while (cursor !== -1) {
      const end = migration.indexOf(";", cursor);
      const statement = migration.slice(cursor, end === -1 ? undefined : end);
      for (const added of statement.matchAll(/add column (?:if not exists )?([a-z_]+)/g)) {
        if (added[1]) names.add(added[1]);
      }
      cursor = migration.indexOf(alterHeader, cursor + alterHeader.length);
    }

    // `unique(...)`/`primary key(...)` clauses are not columns.
    for (const clause of ["unique", "primary", "constraint", "check", "foreign"])
      names.delete(clause);
    return names;
  }

  it("selects only real columns in getLiveCreatorDetail", async () => {
    const selects: Array<{ table: string; columns: string }> = [];
    const creatorRow = {
      id: "44444444-4444-4444-8444-444444444444",
      creator_number: "CR-000001",
      stage_name: "Test Creator",
      status: "ACTIVE",
      current_health_score: null,
      current_health_status: null,
      current_content_buffer_days: null,
      assigned_creator_success_user_id: null,
      assigned_growth_user_id: null,
      contract_status: "SIGNED",
      jurisdiction_review_status: "PENDING",
      adult_confirmation_status: "NOT_STARTED",
      start_date: "2026-01-01",
      timezone: "America/Los_Angeles",
      primary_platform: "ONLYFANS",
      priority: null,
      updated_at: "2026-01-01T00:00:00+00:00",
    };

    function makeChain(table: string): Record<string, unknown> {
      const chain: Record<string, unknown> = {};
      chain["select"] = (columns: string) => {
        selects.push({ table, columns });
        return chain;
      };
      for (const op of ["eq", "gte", "order", "limit", "in", "is", "neq"]) chain[op] = () => chain;
      chain["maybeSingle"] = () =>
        Promise.resolve({ data: table === "creators" ? creatorRow : null, error: null });
      chain["then"] = (resolve: (value: unknown) => unknown) =>
        resolve({ data: [], error: null, count: 0 });
      return chain;
    }
    adminClient = { from: (table: string) => makeChain(table) };

    await liveData.getLiveCreatorDetail(creatorRow.id);

    expect(selects.length).toBeGreaterThan(0);
    for (const { table, columns } of selects) {
      // Skip embedded-resource selects (`creators(stage_name)`) and count heads.
      if (columns.includes("(")) continue;
      const real = columnsOf(table);
      for (const column of columns.split(",").map((entry) => entry.trim())) {
        expect(real.has(column), `${table}.${column} does not exist in the schema`).toBe(true);
      }
    }
  });
});
