begin;

-- Activation is resumable and every step is retryable, so each record an
-- activation creates needs a natural key to upsert against. Most of the tables
-- involved already have one (creator_brand_profiles.creator_id is unique,
-- creator_health_scores is unique per score_date, content_pillars per name, and
-- so on). These two did not, which meant a retried step would insert a second
-- row rather than recognising its own earlier work.
--
-- Same shape as tasks.idempotency_key and content_requests.idempotency_key.

alter table public.creator_competitors add column if not exists idempotency_key text;
create unique index if not exists creator_competitors_org_idempotency_uidx
  on public.creator_competitors (organization_id, idempotency_key)
  where idempotency_key is not null;

alter table public.social_accounts add column if not exists idempotency_key text;
create unique index if not exists social_accounts_org_idempotency_uidx
  on public.social_accounts (organization_id, idempotency_key)
  where idempotency_key is not null;

-- Report schedules are what SCHEDULE_DAILY_REPORT and SCHEDULE_WEEKLY_REVIEW
-- create. There was no table for them at all, so those steps had nothing to
-- write to even in principle.
create table if not exists public.creator_report_schedules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  creator_id uuid not null references public.creators(id) on delete cascade,
  cadence text not null check (cadence in ('DAILY', 'WEEKLY')),
  timezone text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (creator_id, cadence)
);

create index if not exists creator_report_schedules_org_idx
  on public.creator_report_schedules (organization_id, active);

alter table public.creator_report_schedules enable row level security;
revoke all on public.creator_report_schedules from public, anon, authenticated;
grant all on public.creator_report_schedules to service_role;
grant select on public.creator_report_schedules to authenticated;

create policy tenant_isolation on public.creator_report_schedules
  for all to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));

commit;
