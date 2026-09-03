import "server-only";
import { z } from "zod";
import { lookupSlackUser } from "@creatoros/integrations";
import type { AppSession } from "@/lib/auth";
import { appendAudit } from "@/lib/audit";
import { getIntegrationToken } from "@/lib/integration-registry";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * Administration of the Slack → CreatorOS identity map.
 *
 * A mapping is an authorization grant, not a convenience: whoever holds that
 * Slack account can ask the Foundry agent questions as the CreatorOS user it
 * points at, with that user's role and permissions. It was previously created by
 * hand-written SQL, so nothing recorded who granted it or whether the Slack
 * account on the other end existed.
 *
 * Nothing here infers a mapping. An unmapped Slack user stays unmapped and is
 * denied; no address, name or email similarity creates a link.
 */
export interface SlackIdentityRow {
  userId: string;
  displayName: string | null;
  email: string;
  role: string;
  slackUserId: string | null;
  slackDisplayName: string | null;
  slackTeamId: string | null;
  linked: boolean;
  lastVerifiedAt: string | null;
}

const memberRowSchema = z.array(
  z.object({
    user_id: z.string().uuid(),
    role: z.string(),
    users: z.object({ display_name: z.string().nullable(), email: z.string() }).nullable(),
  }),
);

const identityRowSchema = z.array(
  z.object({
    user_id: z.string().uuid(),
    slack_user_id: z.string(),
    slack_team_id: z.string(),
    slack_display_name: z.string().nullable(),
    active: z.boolean(),
    last_verified_at: z.string().nullable(),
  }),
);

function admin() {
  const client = createSupabaseAdminClient();
  if (!client) throw new Error("DATABASE_NOT_CONFIGURED");
  return client;
}

/**
 * Every member of the organization with their Slack link, if any.
 *
 * Members without a link are listed too. Seeing who is *not* linked is the point
 * of the page: an unlinked founder is the reason the agent denied them, and an
 * unexpected link is the thing worth removing.
 */
export async function listSlackIdentities(organizationId: string): Promise<SlackIdentityRow[]> {
  const client = admin();
  const [members, identities] = await Promise.all([
    client
      .from("organization_memberships")
      .select("user_id,role,users(display_name,email)")
      .eq("organization_id", organizationId)
      .eq("active", true),
    client
      .from("slack_user_identities")
      .select("user_id,slack_user_id,slack_team_id,slack_display_name,active,last_verified_at")
      .eq("organization_id", organizationId),
  ]);
  if (members.error) throw new Error(`SLACK_IDENTITY_MEMBERS_FAILED: ${members.error.message}`);
  if (identities.error) throw new Error(`SLACK_IDENTITY_READ_FAILED: ${identities.error.message}`);

  const linkByUser = new Map(
    identityRowSchema
      .parse(identities.data ?? [])
      .filter((row) => row.active)
      .map((row) => [row.user_id, row]),
  );

  return memberRowSchema
    .parse(members.data ?? [])
    .map((member) => {
      const link = linkByUser.get(member.user_id);
      return {
        userId: member.user_id,
        displayName: member.users?.display_name ?? null,
        email: member.users?.email ?? "",
        role: member.role,
        slackUserId: link?.slack_user_id ?? null,
        slackDisplayName: link?.slack_display_name ?? null,
        slackTeamId: link?.slack_team_id ?? null,
        linked: link !== undefined,
        lastVerifiedAt: link?.last_verified_at ?? null,
      };
    })
    .sort((a, b) => (a.displayName ?? a.email).localeCompare(b.displayName ?? b.email));
}

/**
 * Links a Slack account to a CreatorOS user.
 *
 * The Slack account is verified against the workspace before the row is written,
 * so a typo cannot create a live grant addressed to an account that does not
 * exist — one that Slack could later assign to somebody else. The target user
 * must be an active member of the admin's own organization, so this cannot be
 * used to reach across tenants.
 */
export async function linkSlackIdentity(
  session: AppSession,
  input: { userId: string; slackUserId: string },
): Promise<SlackIdentityRow> {
  const client = admin();

  const membership = await client
    .from("organization_memberships")
    .select("user_id,role,users(display_name,email)")
    .eq("organization_id", session.organizationId)
    .eq("user_id", input.userId)
    .eq("active", true)
    .maybeSingle();
  if (membership.error)
    throw new Error(`SLACK_IDENTITY_MEMBER_READ_FAILED: ${membership.error.message}`);
  const member = memberRowSchema.safeParse(membership.data ? [membership.data] : []);
  if (!member.success || member.data.length === 0) throw new Error("USER_NOT_IN_ORGANIZATION");

  const connection = await client
    .from("integration_connections")
    .select("external_account_id")
    .eq("organization_id", session.organizationId)
    .eq("provider", "SLACK")
    .is("creator_id", null)
    .maybeSingle();
  const workspace = z.object({ external_account_id: z.string().min(1) }).safeParse(connection.data);
  if (connection.error || !workspace.success) throw new Error("SLACK_WORKSPACE_NOT_CONNECTED");

  const credentials = await getIntegrationToken(session.organizationId, "SLACK");
  if (!credentials) throw new Error("SLACK_TOKEN_UNAVAILABLE");

  const slackUser = await lookupSlackUser(credentials.token, input.slackUserId);
  if (!slackUser) throw new Error("SLACK_USER_NOT_FOUND");
  // A Slack account in some other workspace is not a member of this tenant's
  // workspace, whatever the id looks like.
  if (slackUser.slackTeamId !== workspace.data.external_account_id)
    throw new Error("SLACK_USER_IN_DIFFERENT_WORKSPACE");

  const verifiedAt = new Date().toISOString();
  const { error } = await client.from("slack_user_identities").upsert(
    {
      organization_id: session.organizationId,
      user_id: input.userId,
      slack_team_id: slackUser.slackTeamId,
      slack_user_id: slackUser.slackUserId,
      slack_display_name: slackUser.displayName,
      active: true,
      last_verified_at: verifiedAt,
      linked_by_user_id: session.userId,
      updated_at: verifiedAt,
    },
    { onConflict: "organization_id,user_id" },
  );
  if (error) throw new Error(`SLACK_IDENTITY_LINK_FAILED: ${error.message}`);

  await appendAudit(session, "slack.identity.linked", "user", input.userId, {
    slackUserId: slackUser.slackUserId,
    slackTeamId: slackUser.slackTeamId,
  });

  const row = member.data[0];
  return {
    userId: input.userId,
    displayName: row?.users?.display_name ?? null,
    email: row?.users?.email ?? "",
    role: row?.role ?? "",
    slackUserId: slackUser.slackUserId,
    slackDisplayName: slackUser.displayName,
    slackTeamId: slackUser.slackTeamId,
    linked: true,
    lastVerifiedAt: verifiedAt,
  };
}

/**
 * Revokes a link by deactivating it rather than deleting the row, so the record
 * that the grant once existed survives. resolveSlackIdentity already refuses an
 * inactive row, so the Slack account loses access immediately.
 */
export async function unlinkSlackIdentity(
  session: AppSession,
  input: { userId: string },
): Promise<void> {
  const { data, error } = await admin()
    .from("slack_user_identities")
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("organization_id", session.organizationId)
    .eq("user_id", input.userId)
    .select("slack_user_id");
  if (error) throw new Error(`SLACK_IDENTITY_UNLINK_FAILED: ${error.message}`);
  const rows = z.array(z.object({ slack_user_id: z.string() })).safeParse(data ?? []);
  if (!rows.success || rows.data.length === 0) throw new Error("SLACK_IDENTITY_NOT_FOUND");

  await appendAudit(session, "slack.identity.unlinked", "user", input.userId, {
    slackUserId: rows.data[0]?.slack_user_id ?? null,
  });
}
