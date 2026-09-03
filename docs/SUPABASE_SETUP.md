# Supabase setup

Status: the project **Foundry Management** (`mqyvckazqawrqqsasomj`) is linked in
`supabase/.temp`, but the CLI on the build machine is not authenticated and the
migration chain has never been executed. Everything below is a human action.

## Client boundaries

Three clients, deliberately separate:

| Client | File | Key | Bypasses RLS |
| --- | --- | --- | --- |
| Browser | `lib/supabase/client.ts` | publishable | no |
| Authenticated server | `lib/supabase/server.ts` | publishable + session cookies | no |
| Privileged server | `lib/supabase/admin.ts` | secret | **yes** |

`server.ts` and `admin.ts` both start with `import "server-only"`, which makes a
build fail rather than ship if either is ever pulled into a client bundle.

Browser roles are additionally reduced at the database level: migration 0001
revokes everything from `anon` and `authenticated` and grants back only
`select`. **Every write goes through a server route that checks permission and
organization ownership first.** RLS still tenant-scopes reads.

## 1. Keys

Supabase → Project Settings → API.

| Variable | Which key |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Publishable (browser-safe) |
| `SUPABASE_SECRET_KEY` | Secret — **server only** |

Older projects may only offer `anon` / `service_role`. Put the service_role key
in `SUPABASE_SERVICE_ROLE_KEY`; both names are accepted and the modern one wins.
There is no legacy fallback for the *publishable* side — if your project predates
publishable keys, put the anon key in `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.

Never put the secret key in a `NEXT_PUBLIC_*` variable.

## 2. Staging first

Per the deployment decision, **do not replay migrations against Foundry
Management.** Create a second Supabase project for staging, point previews and
the first full replay at it, and only then apply forward-only migrations to
production.

Set `PRODUCTION_SUPABASE_PROJECT_REF=mqyvckazqawrqqsasomj` in every environment.
Any non-production deployment resolving to that project refuses to build and
refuses to construct a service-role client.

## 3. Apply migrations

```bash
npx supabase login
npx supabase link --project-ref <staging-ref>
npx supabase db push
```

Seven migrations, in order:

| Migration | Contents |
| --- | --- |
| `..0001_creatoros_v1` | 50 tables, enums, indexes, RLS, audit append-only trigger |
| `..0002_prospect_conversion` | atomic prospect → creator conversion |
| `..0003_production_integrations` | `integration_credentials`, `oauth_states`, rate limiting, one-active-run fence |
| `..0004_disambiguate_prospect_conversion` | fixes an ambiguous reference in 0002 |
| `..0005_foundry_production_bootstrap` | the Foundry organization and workflow definitions |
| `..0006_audit_truncate_guard` | statement-level TRUNCATE guard on audit tables |
| `..0007_slack_agent_ingress` | Slack delivery ledger, identity map, agent transcripts |

**Verify the replay actually succeeded** rather than assuming:

```bash
npx supabase db reset            # staging only — destructive
```

If it fails, that is new information: report it rather than patching by hand.

`supabase/seed.sql` loads fictional demo data (Madison Carter, Ava Monroe, Sarah
Vale). It is idempotent, and it is for **local and staging only**. Never run it
against production — migration 0005 is the production bootstrap.

## 4. Auth

Supabase → Authentication → URL Configuration:

- **Site URL**: `https://<your-domain>`
- **Redirect URLs**: `https://<your-domain>/auth/callback`

Both password sign-in and magic links are implemented.

## 5. Create Ezra and Payton

**Separate accounts. No shared login.** Every write is attributed to the
signed-in user, and a shared account makes the audit trail worthless.

For each founder, in the Supabase dashboard:

1. Authentication → Users → **Add user**, with their real email.
2. Then insert the profile and membership (SQL editor):

```sql
-- Repeat for each founder. auth_user_id comes from the Users list.
insert into public.users (id, email, display_name)
values ('<auth_user_id>', '<email>', '<Display Name>')
on conflict (id) do update set email = excluded.email;

insert into public.organization_memberships (organization_id, user_id, role, active)
values ('00000000-0000-4000-8000-000000000001', '<auth_user_id>', 'super_admin', true)
on conflict (organization_id, user_id) do update set role = excluded.role, active = true;
```

`00000000-0000-4000-8000-000000000001` is the Foundry organization created by
migration 0005. No email is hard-coded anywhere in the application.

`getSession()` requires **exactly one** active membership. A user with two
active memberships resolves to no session at all, which is deliberate — an
ambiguous tenant must never be guessed.

## 6. Prove tenant isolation before trusting it

```bash
NEXT_PUBLIC_SUPABASE_URL=... \
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... \
SUPABASE_SECRET_KEY=... \
node apps/web/scripts/verify-live.mjs
```

It creates two organizations with a user each and asserts that tenant A sees
only its own creator, that a cross-tenant update is rejected or affects no rows,
that a browser role cannot read `integration_credentials`, and that anonymous
access is refused — then cleans up after itself.

It prints `{"status":"LIVE_VERIFIED",...}` on success. **Until it has been run,
tenant isolation is unproven.** Run it against staging first.

## Failure modes

| Symptom | Cause |
| --- | --- |
| `DATABASE_NOT_CONFIGURED` | Supabase URL or secret key missing in that environment |
| Signed in but no session | Zero or two active memberships for that user |
| `duplicate key ... organizations_pkey` on reset | Stale `seed.sql` predating the idempotency fix |
| `PREVIEW_DEPLOYMENT_TARGETS_PRODUCTION_DATABASE` | Working as intended — a preview was pointed at production |
| RLS blocks a server read | A route used the authenticated client where it needs the admin client, or the org filter is wrong |
