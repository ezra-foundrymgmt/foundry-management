import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every creator hub CreatorOS creates is a child of the configured root page, so
 * an unverified page ID is how creator material ends up written somewhere nobody
 * chose — a page shared with the wrong people, or belonging to someone else.
 * Notion accepts any well-formed ID at write time and only fails once a hub is
 * already being created, which is far too late to find out.
 */
interface TableResult {
  data: unknown;
  error: null | { message: string };
}

const tables = new Map<string, TableResult>();
const writes: Array<{ table: string; values: Record<string, unknown> }> = [];
const audits: string[] = [];

function makeQuery(table: string) {
  const chain: Record<string, unknown> = {};
  const result = () => Promise.resolve(tables.get(table) ?? { data: null, error: null });
  for (const op of ["select", "eq", "is", "order", "limit"]) chain[op] = () => chain;
  chain["update"] = (values: Record<string, unknown>) => {
    writes.push({ table, values });
    return chain;
  };
  chain["maybeSingle"] = result;
  chain["single"] = result;
  chain["then"] = (resolve: (value: unknown) => unknown) => resolve(result());
  return chain;
}

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ from: (table: string) => makeQuery(table) }),
}));

vi.mock("@/lib/environment", () => ({
  getEnvironment: () => ({ APP_ENV: "development", INTEGRATION_ENCRYPTION_KEY: "k".repeat(64) }),
}));

vi.mock("@/lib/integration-crypto", () => ({
  decryptSecret: () => "secret_not_a_real_token",
  createOAuthState: () => "state",
  encryptSecret: () => ({ ciphertext: "c", initializationVector: "i", authTag: "a" }),
  hashOAuthState: () => "hash",
}));

const lookupNotionPage =
  vi.fn<() => Promise<{ pageId: string; title: string; archived: boolean } | null>>();
vi.mock("@creatoros/integrations", () => ({ lookupNotionPage: () => lookupNotionPage() }));

vi.mock("@/lib/audit", () => ({
  appendAudit: (_session: unknown, action: string) => {
    audits.push(action);
    return Promise.resolve();
  },
}));

const { configureNotionParent } = await import("./integration-registry");

const ORG = "11111111-1111-4111-8111-111111111111";
const PAGE = "aaaaaaaabbbbccccddddeeeeeeeeeeee";

const session = {
  userId: "22222222-2222-4222-8222-222222222222",
  organizationId: ORG,
  role: "super_admin",
  email: "ezra@example.com",
} as unknown as Parameters<typeof configureNotionParent>[0];

function configurationWrites() {
  return writes.filter((write) => "configuration_json" in write.values);
}

beforeEach(() => {
  tables.clear();
  writes.length = 0;
  audits.length = 0;
  lookupNotionPage.mockReset();
  tables.set("integration_connections", {
    data: { id: "33333333-3333-4333-8333-333333333333", status: "CONNECTED" },
    error: null,
  });
  tables.set("integration_credentials", {
    data: { ciphertext: "c", initialization_vector: "i", auth_tag: "a" },
    error: null,
  });
  lookupNotionPage.mockResolvedValue({ pageId: PAGE, title: "Creators", archived: false });
});

describe("configuring the Creator Hub root", () => {
  it("saves the page and its title once Notion confirms both", async () => {
    const result = await configureNotionParent(session, PAGE);

    expect(result).toEqual({ parentPageId: PAGE, parentPageTitle: "Creators" });
    const write = configurationWrites()[0];
    expect(write?.values["configuration_json"]).toMatchObject({
      parentPageId: PAGE,
      parentPageTitle: "Creators",
    });
    // The title is what lets an admin confirm they picked the page they meant,
    // rather than reading a hex string back to themselves.
    expect(audits).toEqual(["notion.creator_hub_root.configured"]);
  });

  it("refuses a page the integration cannot see", async () => {
    // Notion answers 404 both for a page that does not exist and for one this
    // integration was never granted. Either way it must not become the root.
    lookupNotionPage.mockResolvedValue(null);

    await expect(configureNotionParent(session, PAGE)).rejects.toThrow(/NOTION_PAGE_NOT_SHARED/);
    expect(configurationWrites()).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("refuses an archived page", async () => {
    lookupNotionPage.mockResolvedValue({ pageId: PAGE, title: "Old", archived: true });

    await expect(configureNotionParent(session, PAGE)).rejects.toThrow(/NOTION_PAGE_ARCHIVED/);
    expect(configurationWrites()).toEqual([]);
  });

  it("refuses when the Notion connection has no usable token", async () => {
    tables.set("integration_connections", {
      data: { id: "33333333-3333-4333-8333-333333333333", status: "DISCONNECTED" },
      error: null,
    });

    await expect(configureNotionParent(session, PAGE)).rejects.toThrow(/NOTION_TOKEN_UNAVAILABLE/);
    // Nothing is asked of Notion without a token, and nothing is written.
    expect(lookupNotionPage).not.toHaveBeenCalled();
    expect(configurationWrites()).toEqual([]);
  });
});
