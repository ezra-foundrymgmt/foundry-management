import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ACTIVE is the status Foundry runs on. These pin down what it is allowed to
 * mean: not "the workflow reached its last step", but "every record ACTIVE
 * implies is actually in the database right now".
 */
interface CountResult {
  count: number | null;
  error: { message: string } | null;
}

interface Query {
  select: (columns: string, options?: unknown) => Query;
  eq: (column: string, value: string | boolean | null) => Query;
  is: (column: string, value: string | boolean | null) => Query;
  maybeSingle: () => Promise<{ data: unknown; error: { message: string } | null }>;
  then: (resolve: (value: CountResult) => unknown) => unknown;
}

/** Filters that only scope the query to this creator carry no meaning as keys. */
const SCOPING_COLUMNS = ["organization_id", "creator_id", "id", "resource_id"];

const counts = new Map<string, number>();
const failingTables = new Set<string>();
let creatorRow: unknown = null;
let creatorError: { message: string } | null = null;

function makeQuery(table: string): Query {
  const filters: string[] = [];
  const record = (column: string, value: string | boolean | null) => {
    if (!SCOPING_COLUMNS.includes(column))
      filters.push(`${column}=${value === null ? "null" : String(value)}`);
  };
  const chain: Query = {
    select: () => chain,
    eq: (column, value) => {
      record(column, value);
      return chain;
    },
    is: (column, value) => {
      record(column, value);
      return chain;
    },
    maybeSingle: () => Promise.resolve({ data: creatorRow, error: creatorError }),
    then: (resolve) => {
      if (failingTables.has(table)) return resolve({ count: null, error: { message: "boom" } });
      const key = [table, ...filters].join("|");
      return resolve({ count: counts.get(key) ?? 0, error: null });
    },
  };
  return chain;
}

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ from: (table: string) => makeQuery(table) }),
}));

const { evaluateActivationReadiness } = await import("./activation-readiness");

const ORG = "11111111-1111-4111-8111-111111111111";
const CREATOR = "22222222-2222-4222-8222-222222222222";

/** A creator whose every human prerequisite is satisfied. */
function eligibleCreator(overrides: Record<string, unknown> = {}) {
  return {
    id: CREATOR,
    stage_name: "Madison Carter",
    status: "ONBOARDING",
    contract_status: "SIGNED",
    adult_confirmation_status: "CONFIRMED",
    jurisdiction_review_status: "APPROVED",
    email: "madison@example.com",
    timezone: "America/Los_Angeles",
    assigned_creator_success_user_id: "33333333-3333-4333-8333-333333333333",
    assigned_growth_user_id: null,
    ...overrides,
  };
}

/** Every record a completed activation is supposed to have left behind. */
const SATISFIED: ReadonlyArray<readonly [string, number]> = [
  ["creator_boundaries|active=true", 2],
  ["creator_brand_profiles", 1],
  ["creator_health_scores", 1],
  ["creator_pnl_periods", 1],
  ["content_inventory_snapshots", 1],
  ["creator_competitors", 1],
  ["content_pillars", 3],
  ["tasks|source_type=CREATOR_ACTIVATION_V1", 5],
  ["social_accounts", 3],
  ["integration_connections|provider=CREATOR_REVENUE", 1],
  ["creator_report_schedules|cadence=DAILY|active=true", 1],
  ["creator_report_schedules|cadence=WEEKLY|active=true", 1],
  ["provisioned_resources|provider=SLACK|archived_at=null", 2],
  ["provisioned_resources|provider=NOTION|archived_at=null", 2],
  ["audit_events|resource_type=creator", 2],
  ["creator_baselines", 1],
];

function evaluate() {
  return evaluateActivationReadiness({ organizationId: ORG, creatorId: CREATOR });
}

beforeEach(() => {
  counts.clear();
  failingTables.clear();
  creatorError = null;
  creatorRow = eligibleCreator();
  for (const [key, value] of SATISFIED) counts.set(key, value);
});

describe("activation readiness", () => {
  it("is READY only when every record actually exists", async () => {
    const readiness = await evaluate();

    expect(readiness.status).toBe("READY");
    expect(readiness.reasons).toEqual([]);
    expect(readiness.checks.every((entry) => entry.satisfied)).toBe(true);
  });

  it("is WAITING when only the baseline has not arrived", async () => {
    counts.set("creator_baselines", 0);

    const readiness = await evaluate();

    expect(readiness.status).toBe("WAITING");
    expect(readiness.reasons).toEqual([expect.stringContaining("Frozen baseline")]);
  });

  it("is INCOMPLETE when CreatorOS owes a record it never created", async () => {
    counts.set("creator_brand_profiles", 0);

    const readiness = await evaluate();

    expect(readiness.status).toBe("INCOMPLETE");
    expect(readiness.reasons).toEqual([expect.stringContaining("Brand Dossier")]);
  });

  it("is BLOCKED when a human decision is missing", async () => {
    creatorRow = eligibleCreator({ contract_status: "DRAFT" });

    const readiness = await evaluate();

    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.reasons[0]).toContain("Signed contract");
  });

  it("reports the blocker rather than the missing baseline when both are true", async () => {
    // Answering WAITING here would send someone to wait for baseline data that
    // should never have been requested from an unsigned creator.
    creatorRow = eligibleCreator({ contract_status: null });
    counts.set("creator_baselines", 0);
    counts.set("creator_brand_profiles", 0);

    const readiness = await evaluate();

    expect(readiness.status).toBe("BLOCKED");
    // Every unsatisfied check is still reported, most severe first.
    expect(readiness.reasons).toHaveLength(3);
    expect(readiness.reasons[0]).toContain("Signed contract");
    expect(readiness.reasons[1]).toContain("Brand Dossier");
    expect(readiness.reasons[2]).toContain("Frozen baseline");
  });

  it("prefers INCOMPLETE over WAITING", async () => {
    counts.set("creator_baselines", 0);
    counts.set("content_pillars", 0);

    const readiness = await evaluate();

    expect(readiness.status).toBe("INCOMPLETE");
  });

  it("treats a half-provisioned integration as incomplete", async () => {
    // The creator-facing channel exists and the internal one does not. A count
    // of "more than zero" would call that provisioned.
    counts.set("provisioned_resources|provider=SLACK|archived_at=null", 1);

    const readiness = await evaluate();

    expect(readiness.status).toBe("INCOMPLETE");
    expect(readiness.reasons).toEqual([expect.stringContaining("1 of 2")]);
  });

  it("requires an owner from either team, not both", async () => {
    creatorRow = eligibleCreator({
      assigned_creator_success_user_id: null,
      assigned_growth_user_id: "44444444-4444-4444-8444-444444444444",
    });

    expect((await evaluate()).status).toBe("READY");

    creatorRow = eligibleCreator({
      assigned_creator_success_user_id: null,
      assigned_growth_user_id: null,
    });

    const readiness = await evaluate();
    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.reasons[0]).toContain("Assigned Foundry owner");
  });

  it("refuses to answer when a check cannot be read", async () => {
    // A failed count read as zero would report a healthy creator as INCOMPLETE;
    // a failed baseline count read as zero would be worse in the other
    // direction on any check whose absence is the passing case.
    failingTables.add("creator_baselines");

    await expect(evaluate()).rejects.toThrow(/READINESS_COUNT_FAILED:creator_baselines/);
  });

  it("refuses to answer for a creator outside the organization", async () => {
    creatorRow = null;

    await expect(evaluate()).rejects.toThrow(/CREATOR_NOT_FOUND/);
  });

  it("does not consult workflow status or step counts", async () => {
    // The point of the evaluator: a run whose steps all say SUCCEEDED but whose
    // records are absent must not read as READY.
    for (const [key] of SATISFIED) counts.set(key, 0);

    const readiness = await evaluate();

    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.checks.filter((entry) => entry.satisfied)).toHaveLength(6);
  });
});
