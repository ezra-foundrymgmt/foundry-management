/**
 * Adversarial live verification of the browser-facing data boundary.
 *
 * Run against a staging Supabase project that has the full migration chain
 * applied:
 *
 *   NEXT_PUBLIC_SUPABASE_URL=... \
 *   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... \
 *   SUPABASE_SECRET_KEY=... \
 *   node apps/web/scripts/verify-live.mjs
 *
 * WHAT THIS ASSERTS, AND WHY IT CHANGED
 *
 * This script originally asserted that a signed-in user could read its own
 * organization's `creators` row and not another organization's — that is, that
 * `authenticated` held `select` and RLS did the tenant filtering.
 *
 * Migration 0012 removed that model deliberately. It revoked `select on all
 * tables in schema public from authenticated`, because migration 0001's blanket
 * grant let any signed-in user read creator_pnl_periods, audit_events,
 * creator_revenue_daily, meetings and integration_connections straight from
 * PostgREST with the publishable key and their own access token, bypassing every
 * role check in the app. The browser Supabase client is used only to sign in;
 * every page reads through the server-held service role after a role check.
 *
 * So the boundary is now enforced by the grant, with RLS as a second layer, and
 * the old assertion could never pass: reading `creators` as a browser user
 * raises `permission denied for table creators`. That is a stronger outcome than
 * the script was checking for, so the read assertions below were rewritten to
 * demand refusal rather than filtered success. Nothing was relaxed to get a
 * green result — every check that used to pass still has to pass, and the reads
 * now require a hard refusal.
 *
 * The one intended exception is `organization_memberships`: getSession()
 * resolves the caller's own membership as the caller, before any role is known.
 * It is granted on four columns only and policied to the caller's own row.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const serviceKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
assert(url && publishableKey && serviceKey, "Live Supabase environment variables are required.");

const options = { auth: { autoRefreshToken: false, persistSession: false } };
const admin = createClient(url, serviceKey, options);
const fixture = randomUUID().slice(0, 8);
const password = `${randomBytes(24).toString("base64url")}Aa1!`;
const organizationA = randomUUID();
const organizationB = randomUUID();
const creatorA = randomUUID();
const creatorB = randomUUID();
const createdUserIds = [];

/**
 * Tables a signed-in browser user must not be able to read. The middle six are
 * the confirmed attack surface migration 0012 names; `creators` and `tasks`
 * cover the ordinary business case, and `integration_credentials` holds the
 * encrypted provider tokens.
 */
const BROWSER_DENIED_TABLES = [
  "creators",
  "organizations",
  "audit_events",
  "creator_pnl_periods",
  "creator_revenue_daily",
  "meetings",
  "integration_connections",
  "integration_credentials",
  "tasks",
];

async function requireSuccess(operation, label) {
  const result = await operation;
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

try {
  const users = [];
  for (const suffix of ["a", "b"]) {
    const data = await requireSuccess(
      admin.auth.admin.createUser({
        email: `creatoros-live-${fixture}-${suffix}@example.invalid`,
        password,
        email_confirm: true,
      }),
      `create user ${suffix}`,
    );
    users.push(data.user);
    createdUserIds.push(data.user.id);
  }

  await requireSuccess(
    admin.from("organizations").insert([
      { id: organizationA, name: "RLS fixture A", slug: `rls-${fixture}-a` },
      { id: organizationB, name: "RLS fixture B", slug: `rls-${fixture}-b` },
    ]),
    "create organizations",
  );
  await requireSuccess(
    admin.from("users").insert([
      { id: users[0].id, email: users[0].email, display_name: "Fixture A" },
      { id: users[1].id, email: users[1].email, display_name: "Fixture B" },
    ]),
    "create profiles",
  );
  await requireSuccess(
    admin.from("organization_memberships").insert([
      { organization_id: organizationA, user_id: users[0].id, role: "viewer" },
      { organization_id: organizationB, user_id: users[1].id, role: "viewer" },
    ]),
    "create memberships",
  );
  await requireSuccess(
    admin.from("creators").insert([
      {
        id: creatorA,
        organization_id: organizationA,
        creator_number: `RLS-${fixture}-A`,
        preferred_name: "Fixture A",
        stage_name: "Fixture A",
        email: `creator-${fixture}-a@example.invalid`,
        timezone: "UTC",
        start_date: "2026-09-02",
        contract_status: "SIGNED",
        jurisdiction_review_status: "PASSED",
      },
      {
        id: creatorB,
        organization_id: organizationB,
        creator_number: `RLS-${fixture}-B`,
        preferred_name: "Fixture B",
        stage_name: "Fixture B",
        email: `creator-${fixture}-b@example.invalid`,
        timezone: "UTC",
        start_date: "2026-09-02",
        contract_status: "SIGNED",
        jurisdiction_review_status: "PASSED",
      },
    ]),
    "create creators",
  );

  const clientA = createClient(url, publishableKey, options);
  await requireSuccess(
    clientA.auth.signInWithPassword({ email: users[0].email, password }),
    "sign in fixture A",
  );

  // 1. The grant boundary. Before migration 0012 every one of these returned rows
  //    to any signed-in user, whatever role the app had assigned them.
  const deniedReads = {};
  for (const table of BROWSER_DENIED_TABLES) {
    const result = await clientA.from(table).select("*").limit(1);
    assert(
      result.error,
      `A signed-in browser user must not read public.${table}, but the read succeeded.`,
    );
    deniedReads[table] = result.error.code ?? result.error.message;
  }

  // 2. The one intended exception, scoped to the caller's own row: getSession()
  //    has to resolve the caller's membership before any role is known.
  const ownMembership = await requireSuccess(
    clientA.from("organization_memberships").select("organization_id,user_id,role,active"),
    "read own membership",
  );
  assert.deepEqual(ownMembership, [
    { organization_id: organizationA, user_id: users[0].id, role: "viewer", active: true },
  ]);

  // 3. RLS on that exception: another user's membership is invisible, so the
  //    table cannot be used to enumerate colleagues or discover who holds which
  //    role. RLS filters rather than refuses, so this is zero rows, not an error.
  const foreignMembership = await requireSuccess(
    clientA
      .from("organization_memberships")
      .select("organization_id,user_id,role,active")
      .eq("user_id", users[1].id),
    "read foreign membership",
  );
  assert.deepEqual(foreignMembership, [], "A user must not see another user's membership row.");

  // 4. The exception is column-scoped as well as row-scoped: `id` is not granted.
  const ungrantedColumn = await clientA.from("organization_memberships").select("id").limit(1);
  assert(
    ungrantedColumn.error,
    "Columns outside the four-column grant on organization_memberships must be refused.",
  );

  // 5. No write grant exists for browser roles at all, so a cross-tenant write is
  //    refused before RLS is consulted.
  const crossTenantUpdate = await clientA
    .from("creators")
    .update({ stage_name: "Forbidden" })
    .eq("id", creatorB)
    .select("id");
  assert(
    crossTenantUpdate.error || crossTenantUpdate.data.length === 0,
    "Cross-tenant update must be rejected or affect no rows.",
  );

  // 6. And a same-tenant write is refused too: the browser never writes.
  const ownTenantUpdate = await clientA
    .from("creators")
    .update({ stage_name: "Forbidden" })
    .eq("id", creatorA)
    .select("id");
  assert(
    ownTenantUpdate.error || ownTenantUpdate.data.length === 0,
    "A browser user must not write its own tenant's creators either.",
  );

  // 7. Anonymous callers get nothing.
  const anonymous = createClient(url, publishableKey, options);
  const anonymousOrganizations = await anonymous.from("organizations").select("id");
  assert(anonymousOrganizations.error, "Anonymous users must not read tenant data.");
  const anonymousMemberships = await anonymous.from("organization_memberships").select("user_id");
  assert(
    anonymousMemberships.error || anonymousMemberships.data.length === 0,
    "Anonymous users must not read memberships.",
  );

  // 8. The path the app actually uses still works, and is tenant-filterable.
  //    Without this, every check above would also pass on a database that simply
  //    denied everyone, and CreatorOS would be unable to read its own data.
  const serviceScoped = await requireSuccess(
    admin.from("creators").select("id,organization_id").eq("organization_id", organizationA),
    "service role reads tenant A",
  );
  assert.deepEqual(serviceScoped, [{ id: creatorA, organization_id: organizationA }]);

  console.log(
    JSON.stringify({
      status: "LIVE_VERIFIED",
      browserTableReadsDenied: deniedReads,
      ownMembershipReadable: true,
      foreignMembershipInvisible: true,
      ungrantedColumnDenied: true,
      crossTenantMutationBlocked: true,
      sameTenantBrowserMutationBlocked: true,
      anonymousAccessBlocked: true,
      serviceRoleTenantScopedReadWorks: true,
    }),
  );
} finally {
  await admin.from("creators").delete().in("id", [creatorA, creatorB]);
  await admin.from("organization_memberships").delete().in("user_id", createdUserIds);
  await admin.from("users").delete().in("id", createdUserIds);
  await admin.from("organizations").delete().in("id", [organizationA, organizationB]);
  for (const userId of createdUserIds) await admin.auth.admin.deleteUser(userId);
}
