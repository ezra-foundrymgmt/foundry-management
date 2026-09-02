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
  const visibleCreators = await requireSuccess(
    clientA.from("creators").select("id,organization_id"),
    "read tenant A creators",
  );
  assert.deepEqual(visibleCreators, [{ id: creatorA, organization_id: organizationA }]);

  const crossTenantUpdate = await clientA
    .from("creators")
    .update({ stage_name: "Forbidden" })
    .eq("id", creatorB)
    .select("id");
  assert(
    crossTenantUpdate.error || crossTenantUpdate.data.length === 0,
    "Cross-tenant update must be rejected or affect no rows.",
  );

  const protectedCredentials = await clientA.from("integration_credentials").select("id");
  assert(protectedCredentials.error, "Browser users must not read provider credentials.");

  const anonymous = createClient(url, publishableKey, options);
  const anonymousOrganizations = await anonymous.from("organizations").select("id");
  assert(anonymousOrganizations.error, "Anonymous users must not read tenant data.");

  console.log(
    JSON.stringify({
      status: "LIVE_VERIFIED",
      tenantReadIsolation: true,
      crossTenantMutationBlocked: true,
      credentialTableBlocked: true,
      anonymousAccessBlocked: true,
    }),
  );
} finally {
  await admin.from("creators").delete().in("id", [creatorA, creatorB]);
  await admin.from("organization_memberships").delete().in("user_id", createdUserIds);
  await admin.from("users").delete().in("id", createdUserIds);
  await admin.from("organizations").delete().in("id", [organizationA, organizationB]);
  for (const userId of createdUserIds) await admin.auth.admin.deleteUser(userId);
}
