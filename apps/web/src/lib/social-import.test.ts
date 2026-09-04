import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The fake records every filter and payload, so these assert the real query
 * shape — that ownership comes from the session and never from the request,
 * and that the upsert names the arbiter migration 202609040015 actually adds.
 */
interface RecordedQuery {
  table: string;
  op: string;
  filters: Array<[string, string, unknown]>;
  payload?: unknown;
  options?: unknown;
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
      entry.filters.push([op, typeof args[0] === "string" ? args[0] : "", args[1]]);
      return chain;
    };
  for (const op of ["insert", "update", "upsert"])
    chain[op] = (payload: unknown, options?: unknown) => {
      entry.op = op;
      entry.payload = payload;
      entry.options = options;
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
  createSupabaseAdminClient: (): { from: (table: string) => Record<string, unknown> } => ({
    from: (table: string) => makeQuery(table),
  }),
}));
vi.mock("@/lib/audit", () => ({ appendAudit: (...args: unknown[]) => appendAudit(...(args as [])) }));
vi.mock("@/lib/observability", () => ({
  logEvent: (...args: unknown[]) => {
    logEvent(...(args as []));
  },
}));

const { importCreatorSocialPosts, SocialImportError, socialImportSchema } = await import(
  "./social-import"
);

const ORG = "11111111-1111-4111-8111-111111111111";
const CREATOR = "20000000-0000-4000-8000-000000000001";

const session = {
  userId: "22222222-2222-4222-8222-222222222222",
  organizationId: ORG,
  role: "super_admin" as const,
  email: "ezra@foundrymgmt.net",
};

/** Every metric key present, which the schema requires. */
function post(overrides: Record<string, unknown> = {}) {
  return {
    externalPostId: "POST-1",
    publishedAt: "2026-09-01T12:00:00+00:00",
    measuredAt: "2026-09-03T12:00:00+00:00",
    format: null,
    hookLabel: null,
    captionSummary: null,
    durationSeconds: null,
    views: 1000,
    reach: 800,
    impressions: 1200,
    likes: 50,
    comments: 4,
    shares: 2,
    saves: 7,
    profileVisits: 30,
    outboundClicks: 9,
    followsGenerated: 3,
    ...overrides,
  };
}

function importOf(overrides: Record<string, unknown> = {}) {
  return {
    platform: "INSTAGRAM" as const,
    source: "OPERATOR_ENTRY",
    dataConfidence: "MEASURED" as const,
    rows: [post()],
    ...overrides,
  };
}

beforeEach(() => {
  recorded.length = 0;
  rows = [{ id: "aaaaaaaa-0000-4000-8000-000000000001" }];
  singleResult = { id: CREATOR, stage_name: "Nova Reign" };
  queryError = null;
  appendAudit.mockClear();
  logEvent.mockClear();
});

describe("social import validation", () => {
  it("requires a metric key to be present even when its value is unknown", () => {
    // The distinction the whole schema exists for: an omitted key is a 400,
    // an explicit null means "not measured", 0 means "measured zero".
    const withoutReach = post();
    delete (withoutReach as Record<string, unknown>)["reach"];
    expect(socialImportSchema.safeParse(importOf({ rows: [withoutReach] })).success).toBe(false);

    expect(socialImportSchema.safeParse(importOf({ rows: [post({ reach: null })] })).success).toBe(
      true,
    );
    expect(socialImportSchema.safeParse(importOf({ rows: [post({ reach: 0 })] })).success).toBe(
      true,
    );
  });

  it("refuses a platform outside the closed vocabulary", () => {
    // platform is part of the natural key, so free text would let
    // "Instagram" and "INSTAGRAM" be two rows for one post.
    expect(socialImportSchema.safeParse(importOf({ platform: "Instagram" })).success).toBe(false);
    expect(socialImportSchema.safeParse(importOf({ platform: "MYSPACE" })).success).toBe(false);
  });

  it("refuses an empty post id rather than accepting an unidentifiable row", () => {
    expect(socialImportSchema.safeParse(importOf({ rows: [post({ externalPostId: "  " })] })).success).toBe(
      false,
    );
  });

  it("accepts the numeric-offset timestamp PostgREST returns, not just a bare Z", () => {
    expect(
      socialImportSchema.safeParse(importOf({ rows: [post({ publishedAt: "2026-09-01T12:00:00+00:00" })] }))
        .success,
    ).toBe(true);
  });

  it("refuses a negative or absurd metric", () => {
    expect(socialImportSchema.safeParse(importOf({ rows: [post({ reach: -1 })] })).success).toBe(false);
    expect(
      socialImportSchema.safeParse(importOf({ rows: [post({ reach: 1e15 })] })).success,
    ).toBe(false);
  });
});

describe("importCreatorSocialPosts", () => {
  it("proves the creator belongs to the caller's organization first", async () => {
    await importCreatorSocialPosts(session, CREATOR, importOf());
    const lookup = recorded.find((entry) => entry.table === "creators");
    expect(lookup?.filters).toEqual(
      expect.arrayContaining([
        ["eq", "organization_id", ORG],
        ["eq", "id", CREATOR],
      ]),
    );
  });

  it("refuses a creator from another tenant rather than writing against it", async () => {
    singleResult = null;
    await expect(importCreatorSocialPosts(session, CREATOR, importOf())).rejects.toThrow(
      "CREATOR_NOT_FOUND",
    );
    expect(recorded.some((entry) => entry.op === "upsert")).toBe(false);
  });

  it("upserts on the arbiter the migration adds, so a re-import replaces", async () => {
    await importCreatorSocialPosts(session, CREATOR, importOf());
    const write = recorded.find((entry) => entry.op === "upsert");
    expect(write?.table).toBe("social_posts");
    expect(write?.options).toEqual({ onConflict: "creator_id,platform,external_post_id" });
  });

  it("writes the organization from the session, never from the request", async () => {
    await importCreatorSocialPosts(session, CREATOR, importOf());
    const write = recorded.find((entry) => entry.op === "upsert");
    expect((write?.payload as Array<Record<string, unknown>>)[0]).toMatchObject({
      organization_id: ORG,
      creator_id: CREATOR,
      platform: "INSTAGRAM",
      external_post_id: "POST-1",
      data_confidence: "MEASURED",
    });
  });

  it("carries an unmeasured metric through as null, not as zero", async () => {
    await importCreatorSocialPosts(session, CREATOR, importOf({ rows: [post({ reach: null })] }));
    const write = recorded.find((entry) => entry.op === "upsert");
    expect((write?.payload as Array<Record<string, unknown>>)[0]?.["reach"]).toBeNull();
  });

  it("refuses two rows for the same post rather than letting Postgres raise 21000", async () => {
    await expect(
      importCreatorSocialPosts(
        session,
        CREATOR,
        importOf({ rows: [post({ externalPostId: "P" }), post({ externalPostId: "P" })] }),
      ),
    ).rejects.toThrow("DUPLICATE_POST_IDS_IN_PAYLOAD");
    expect(recorded.some((entry) => entry.op === "upsert")).toBe(false);
  });

  it("refuses a post measured before it was published", async () => {
    await expect(
      importCreatorSocialPosts(
        session,
        CREATOR,
        importOf({
          rows: [post({ publishedAt: "2026-09-05T12:00:00+00:00", measuredAt: "2026-09-01T12:00:00+00:00" })],
        }),
      ),
    ).rejects.toThrow("MEASURED_BEFORE_PUBLISHED");
  });

  it("records the run in the import ledger with provider and source the right way round", async () => {
    await importCreatorSocialPosts(session, CREATOR, importOf());
    const ledger = recorded.find((entry) => entry.table === "data_import_runs");
    expect(ledger?.payload).toMatchObject({
      // provider is the external system; source is how the data reached us.
      provider: "INSTAGRAM",
      source: "OPERATOR_ENTRY",
      creator_id: CREATOR,
      organization_id: ORG,
      rows_received: 1,
    });
  });

  it("does not fail a committed import because the audit write failed", async () => {
    appendAudit.mockRejectedValueOnce(new Error("audit_events insert failed"));
    const result = await importCreatorSocialPosts(session, CREATOR, importOf());
    expect(result.rowsWritten).toBe(1);
    expect(logEvent).toHaveBeenCalledWith(
      "error",
      "social_import.audit_failed",
      expect.objectContaining({ creatorId: CREATOR }),
    );
  });

  it("never puts a driver message in the error the caller sees", async () => {
    queryError = { message: 'relation "public.social_posts" does not exist' };
    await expect(importCreatorSocialPosts(session, CREATOR, importOf())).rejects.toThrow(
      "SOCIAL_IMPORT_DATABASE_FAILED",
    );
  });

  it("carries a status the route can turn into an HTTP code", () => {
    expect(new SocialImportError("CREATOR_NOT_FOUND", 404).status).toBe(404);
  });
});

/**
 * An import REPLACES the whole row, which is what keeps every figure on it
 * attributable to the one `measured_at` beside them. The cost is that an
 * operator correcting a single metric clears the ones they left blank — the
 * right write, but it must not be a silent one.
 */
describe("clearing a previously-measured figure is reported, not silent", () => {
  it("counts a measured value the operator left blank this time", async () => {
    // The stored row has reach and likes; this reading measured only views.
    rows = [{ reach: 5000, likes: 40, views: null }];
    const result = await importCreatorSocialPosts(
      session,
      CREATOR,
      importOf({ rows: [post({ reach: null, likes: null, views: 900 })] }),
    );
    expect(result.clearedMeasurements).toBe(2);
  });

  it("reports nothing cleared when the import measures everything again", async () => {
    rows = [{ reach: 5000, likes: 40 }];
    const result = await importCreatorSocialPosts(session, CREATOR, importOf());
    expect(result.clearedMeasurements).toBe(0);
  });

  it("does not count a value that merely changed", async () => {
    // A correction is ordinary; only measured -> unmeasured is worth warning
    // about, because nothing on the resulting row shows a number used to exist.
    rows = [{ reach: 100 }];
    const result = await importCreatorSocialPosts(
      session,
      CREATOR,
      importOf({ rows: [post({ reach: 9999 })] }),
    );
    expect(result.clearedMeasurements).toBe(0);
  });
});
