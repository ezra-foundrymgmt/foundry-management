begin;

-- Slack retries any event it does not receive a 2xx for within three seconds,
-- and redelivers on its own schedule besides. Without a delivery ledger the
-- agent answers the same mention several times and repeats any write it made.
create table if not exists public.slack_event_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  slack_team_id text not null,
  slack_event_id text not null,
  event_type text not null,
  channel_id text,
  slack_user_id text,
  status text not null default 'RECEIVED',
  error_message text,
  correlation_id uuid not null default gen_random_uuid(),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  -- Slack guarantees event_id uniqueness per workspace, so this is the fence
  -- that makes redelivery a no-op rather than a duplicate answer.
  unique (slack_team_id, slack_event_id)
);

create index if not exists slack_event_deliveries_org_received_idx
  on public.slack_event_deliveries(organization_id, received_at desc);

-- A Slack user is not a CreatorOS user. Every agent tool call must run as a
-- real CreatorOS identity with a real role, so unmapped Slack users get no
-- access at all rather than defaulting to some ambient permission.
create table if not exists public.slack_user_identities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  slack_team_id text not null,
  slack_user_id text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (slack_team_id, slack_user_id),
  unique (organization_id, user_id)
);

-- Every agent turn is recorded: which human asked, which tools ran, and what
-- was answered. The agent is not a source of truth, so its output has to be
-- reconstructable and reviewable after the fact.
create table if not exists public.agent_interactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid references public.users(id) on delete set null,
  surface text not null default 'SLACK',
  slack_team_id text,
  slack_channel_id text,
  slack_user_id text,
  slack_thread_ts text,
  prompt text not null,
  response text,
  tool_calls_json jsonb not null default '[]'::jsonb,
  model text,
  status text not null default 'RUNNING',
  error_message text,
  correlation_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists agent_interactions_org_created_idx
  on public.agent_interactions(organization_id, created_at desc);

alter table public.slack_event_deliveries enable row level security;
alter table public.slack_user_identities enable row level security;
alter table public.agent_interactions enable row level security;

-- Delivery ledger and identity mapping are infrastructure: no browser role
-- reads or writes them at all.
revoke all on public.slack_event_deliveries from public, anon, authenticated;
revoke all on public.slack_user_identities from public, anon, authenticated;
revoke all on public.agent_interactions from public, anon, authenticated;
grant all on public.slack_event_deliveries to service_role;
grant all on public.slack_user_identities to service_role;
grant all on public.agent_interactions to service_role;

-- Agent transcripts are readable in-app by members of the owning organization,
-- through the same tenant predicate every other business table uses.
-- Dropped first: every other statement in this migration is if-not-exists, and a
-- bare create policy would make the whole file fail on a re-run.
drop policy if exists tenant_isolation on public.agent_interactions;
create policy tenant_isolation on public.agent_interactions
  for all to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));
grant select on public.agent_interactions to authenticated;

/**
 * Claims a Slack event exactly once. Returns true only for the caller that
 * inserted the row; every redelivery of the same event returns false. Doing
 * this in SQL rather than as a read-then-write in application code is what
 * makes it safe when Slack retries land on two instances at the same moment.
 */
create or replace function public.claim_slack_event(
  p_slack_team_id text,
  p_slack_event_id text,
  p_event_type text,
  p_organization_id uuid,
  p_channel_id text,
  p_slack_user_id text
) returns boolean
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  affected integer := 0;
begin
  insert into public.slack_event_deliveries (
    organization_id, slack_team_id, slack_event_id, event_type, channel_id, slack_user_id
  )
  values (
    p_organization_id, p_slack_team_id, p_slack_event_id, p_event_type, p_channel_id, p_slack_user_id
  )
  on conflict (slack_team_id, slack_event_id) do nothing;
  get diagnostics affected = row_count;
  return affected > 0;
end $$;

revoke all on function public.claim_slack_event(text, text, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.claim_slack_event(text, text, text, uuid, text, text)
  to service_role;

commit;
