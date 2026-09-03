begin;

-- Migration 202609020012 found and fixed this exact defect for
-- creator_competitors_org_idempotency_uidx, social_accounts_org_idempotency_uidx
-- and integration_connections_org_provider_creator_uidx: PostgreSQL only infers
-- a partial unique index as an ON CONFLICT arbiter when the statement's own
-- WHERE clause matches the index predicate, and PostgREST's upsert never
-- supplies one, so `on_conflict=organization_id,idempotency_key` against a
-- partial index raises 42P10 on the very first insert. That migration's own
-- comment named the fix as general ("this is why task upserts worked") but
-- missed content_requests_org_idempotency_uidx, added a migration earlier
-- (202609020008) with the identical partial shape.
--
-- create_content_request (apps/web/src/lib/agent/tools.ts) is the only writer
-- against this index and has never been exercised live: it is unreachable
-- until ANTHROPIC_API_KEY is configured. It would have failed on its very
-- first real call, exactly as the three tables above did before migration
-- 202609020012.
--
-- Dropping the predicate is safe for the same reason migration 202609020012
-- gave for the others: a unique index treats NULLs as distinct, so a request
-- with no idempotency key still does not collide with another one that also
-- has none.
drop index if exists public.content_requests_org_idempotency_uidx;
create unique index if not exists content_requests_org_idempotency_uidx
  on public.content_requests (organization_id, idempotency_key);

commit;
