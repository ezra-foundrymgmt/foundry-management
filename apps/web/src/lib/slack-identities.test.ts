import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A Slack identity link is an authorization grant: whoever holds that Slack
 * account gets to ask the Foundry agent questions as the CreatorOS user it
 * points at. These cover the ways a link could be created that nobody intended —
 * a typo'd member ID, an account from another workspace, a user in another
 * tenant — and the refusal each one earns.
 */
interface TableResult {
  data: unknown;
  error: null | { message: string };
}

const tables = new Map<string, TableResult>();
const writes: Array<{ table: string; op: string; values: Record<string, unknown> }> = [];
const audits: Array<{ action: string; resourceId: string; metadata: Record<string, unknown> }> = [];

function makeQuery(table: string) {
  const chain: Record<string, unknown> = {};
  const result = () => Promise.resolve(tables.get(table) ?? { data: null, error: null });
  for (const op of ["select", "eq", "is", "order", "limit"]) chain[op] = () => chain;
  for (const op of ["upsert", "update", "insert"])
    chain[op] = (values: Record<string, unknown>) => {
      writes.push({ table, op, values });
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

const lookupSlackUser =
  vi.fn<() => Promise<{ slackUserId: string; slackTeamId: string; displayName: string } | null>>();
vi.mock("@creatoros/integrations", () => ({ lookupSlackUser: () => lookupSlackUser() }));

const getIntegrationToken = vi.fn<() => Promise<{ token: string } | null>>();
vi.mock("@/lib/integration-registry", () => ({
  getIntegrationToken: () => getIntegrationToken(),
}));

vi.mock("@/lib/audit", () => ({
  appendAudit: (
    _session: unknown,
    action: string,
    _resourceType: string,
    resourceId: string,
    metadata: Record<string, unknown>,
  ) => {
    audits.push({ action, resourceId, metadata });
    return Promise.resolve();
  },
}));

const { linkSlackIdentity, unlinkSlackIdentity, listSlackIdentities } =
  await import("./slack-identities");

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const TEAM = "T0FOUNDRY";

const session = {
  userId: ADMIN,
  organizationId: ORG,
  role: "super_admin",
  email: "ezra@example.com",
} as unknown as Parameters<typeof linkSlackIdentity>[0];

function membership() {
  return {
    user_id: USER,
    role: "creator_success",
    users: { display_name: "Payton", email: "payton@example.com" },
  };
}

beforeEach(() => {
  tables.clear();
  writes.length = 0;
  audits.length = 0;
  lookupSlackUser.mockReset();
  getIntegrationToken.mockReset();
  tables.set("organization_memberships", { data: membership(), error: null });
  tables.set("integration_connections", { data: { external_account_id: TEAM }, error: null });
  tables.set("slack_user_identities", { data: [], error: null });
  getIntegrationToken.mockResolvedValue({ token: "xoxb-not-a-real-token" });
  lookupSlackUser.mockResolvedValue({
    slackUserId: "U0PAYTON",
    slackTeamId: TEAM,
    displayName: "payton",
  });
});

describe("linking a Slack identity", () => {
  it("verifies the Slack account exists before writing the grant", async () => {
    const identity = await linkSlackIdentity(session, { userId: USER, slackUserId: "U0PAYTON" });

    expect(lookupSlackUser).toHaveBeenCalledTimes(1);
    expect(identity).toMatchObject({ linked: true, slackUserId: "U0PAYTON" });
    const write = writes.find((entry) => entry.table === "slack_user_identities");
    expect(write?.values).toMatchObject({
      organization_id: ORG,
      user_id: USER,
      slack_team_id: TEAM,
      slack_user_id: "U0PAYTON",
      slack_display_name: "payton",
      active: true,
      linked_by_user_id: ADMIN,
    });
  });

  it("refuses a member ID Slack does not recognize", async () => {
    // The dangerous version of this bug is silent: a typo'd id creates a live
    // grant addressed to nobody, waiting for Slack to assign that id to someone.
    lookupSlackUser.mockResolvedValue(null);

    await expect(
      linkSlackIdentity(session, { userId: USER, slackUserId: "U0TYPO" }),
    ).rejects.toThrow(/SLACK_USER_NOT_FOUND/);
    expect(writes.filter((entry) => entry.table === "slack_user_identities")).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("refuses an account from a different workspace", async () => {
    lookupSlackUser.mockResolvedValue({
      slackUserId: "U0OUTSIDER",
      slackTeamId: "T0SOMEWHERE_ELSE",
      displayName: "outsider",
    });

    await expect(
      linkSlackIdentity(session, { userId: USER, slackUserId: "U0OUTSIDER" }),
    ).rejects.toThrow(/SLACK_USER_IN_DIFFERENT_WORKSPACE/);
    expect(writes.filter((entry) => entry.table === "slack_user_identities")).toEqual([]);
  });

  it("refuses a user who is not an active member of the organization", async () => {
    tables.set("organization_memberships", { data: null, error: null });

    await expect(
      linkSlackIdentity(session, { userId: USER, slackUserId: "U0PAYTON" }),
    ).rejects.toThrow(/USER_NOT_IN_ORGANIZATION/);
    // The Slack call never happens: tenant membership is checked first.
    expect(lookupSlackUser).not.toHaveBeenCalled();
  });

  it("refuses when the workspace is not connected", async () => {
    tables.set("integration_connections", { data: null, error: null });

    await expect(
      linkSlackIdentity(session, { userId: USER, slackUserId: "U0PAYTON" }),
    ).rejects.toThrow(/SLACK_WORKSPACE_NOT_CONNECTED/);
  });

  it("records who granted the link", async () => {
    await linkSlackIdentity(session, { userId: USER, slackUserId: "U0PAYTON" });

    expect(audits).toEqual([
      {
        action: "slack.identity.linked",
        resourceId: USER,
        metadata: { slackUserId: "U0PAYTON", slackTeamId: TEAM },
      },
    ]);
  });
});

describe("unlinking a Slack identity", () => {
  it("deactivates the grant and records it", async () => {
    tables.set("slack_user_identities", { data: [{ slack_user_id: "U0PAYTON" }], error: null });

    await unlinkSlackIdentity(session, { userId: USER });

    const write = writes.find((entry) => entry.table === "slack_user_identities");
    // Deactivated, not deleted: the record that the grant existed survives.
    expect(write?.op).toBe("update");
    expect(write?.values).toMatchObject({ active: false });
    expect(audits[0]?.action).toBe("slack.identity.unlinked");
  });

  it("reports a user with no link rather than silently succeeding", async () => {
    tables.set("slack_user_identities", { data: [], error: null });

    await expect(unlinkSlackIdentity(session, { userId: USER })).rejects.toThrow(
      /SLACK_IDENTITY_NOT_FOUND/,
    );
    expect(audits).toEqual([]);
  });
});

describe("listing Slack identities", () => {
  it("lists unlinked members too, and ignores deactivated links", async () => {
    tables.set("organization_memberships", { data: [membership()], error: null });
    tables.set("slack_user_identities", {
      data: [
        {
          user_id: USER,
          slack_user_id: "U0OLD",
          slack_team_id: TEAM,
          slack_display_name: "old",
          active: false,
          last_verified_at: null,
        },
      ],
      error: null,
    });

    const rows = await listSlackIdentities(ORG);

    // A revoked grant must not read as a live one.
    expect(rows).toEqual([
      expect.objectContaining({ userId: USER, linked: false, slackUserId: null }),
    ]);
  });
});
