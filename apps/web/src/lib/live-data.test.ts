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
