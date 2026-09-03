begin;

-- Adversarial review, confirmed: every role check in CreatorOS was bypassable
-- with curl.
--
-- Migration 0001 granted `select on all tables in schema public` to
-- `authenticated`, and the tenant_isolation policy it is checked against asks
-- only `is_organization_member(organization_id)` — it knows nothing about roles.
-- So an `editor` or `contractor` who is correctly refused /economics and /audit
-- in the app could read creator_pnl_periods, audit_events, contracts,
-- creator_revenue_daily, meetings and integration_connections directly from
-- PostgREST, using the publishable key and their own access token, both of which
-- are in the browser bundle by design.
--
-- Nothing in the product needed that grant. The browser Supabase client is used
-- only to sign in (apps/web/src/components/login-form.tsx is its sole call
-- site); every page reads through the server-held service role after a role
-- check. The grant was pure attack surface.
revoke select on all tables in schema public from authenticated;

-- The one exception: getSession() resolves the caller's own membership as the
-- caller, before any role is known. It is scoped to the caller's own row rather
-- than the organization, so it cannot be used to enumerate colleagues or read
-- who holds which role.
grant select (organization_id, user_id, role, active)
  on public.organization_memberships to authenticated;

drop policy if exists tenant_isolation on public.organization_memberships;
create policy own_membership_only on public.organization_memberships
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Adversarial review, confirmed: no creator could ever have reached ACTIVE.
--
-- PostgreSQL only infers a partial unique index for ON CONFLICT when the
-- statement supplies a matching index predicate, and PostgREST's upsert does
-- not. So `on_conflict=organization_id,idempotency_key` against a partial index
-- raises 42P10 on the very first insert, with no rows present.
--
-- Three activation steps used exactly that shape — CREATE_COMPETITOR_RESEARCH,
-- REQUEST_SOCIAL_INTEGRATIONS and REQUEST_REVENUE_INTEGRATION — so each failed
-- permanently, Inngest exhausted its retries, and the run ended FAILED. Even if
-- it had not, those three records are readiness conditions, so
-- completeActivation would have refused forever.
--
-- The indexes become non-partial, which is the shape tasks_org_idempotency_uidx
-- already had and which is why task upserts worked. Dropping the predicate
-- changes nothing semantically: a unique index treats NULLs as distinct, so rows
-- without an idempotency key still do not collide with each other.
drop index if exists public.creator_competitors_org_idempotency_uidx;
create unique index if not exists creator_competitors_org_idempotency_uidx
  on public.creator_competitors (organization_id, idempotency_key);

drop index if exists public.social_accounts_org_idempotency_uidx;
create unique index if not exists social_accounts_org_idempotency_uidx
  on public.social_accounts (organization_id, idempotency_key);

-- Same defect, different shape: `where creator_id is not null`. Removing the
-- predicate is safe for the same reason — a creator-scoped row always has a
-- creator_id, and the workspace-level rows (creator_id null) never collide with
-- each other here. Their uniqueness is enforced separately by
-- integration_connections_org_provider_global_uidx, which stays partial because
-- nothing upserts against it.
drop index if exists public.integration_connections_org_provider_creator_uidx;
create unique index if not exists integration_connections_org_provider_creator_uidx
  on public.integration_connections (organization_id, provider, creator_id);

-- Adversarial review, confirmed: an admin could never re-point a Slack account
-- at a different CreatorOS user — the thing they do when someone changes role
-- or leaves.
--
-- slack_user_identities carried two unique constraints and an upsert can only
-- name one, so the write conflicted on the constraint it did not name and
-- failed outright. Retiring the old link first only helps if uniqueness applies
-- to live links, so the Slack-account constraint becomes partial on active.
--
-- It is safe to make this one partial precisely because nothing upserts against
-- it: (organization_id, user_id) is the conflict target and stays a full
-- constraint. That is the same distinction the activation indexes above got
-- wrong.
alter table public.slack_user_identities
  drop constraint if exists slack_user_identities_slack_team_id_slack_user_id_key;
create unique index if not exists slack_user_identities_active_account_uidx
  on public.slack_user_identities (slack_team_id, slack_user_id)
  where active;

commit;
