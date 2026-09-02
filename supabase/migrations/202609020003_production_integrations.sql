begin;

alter table public.integration_connections
  add column if not exists external_workspace_name text,
  add column if not exists scopes text[] not null default '{}',
  add column if not exists capabilities_json jsonb not null default '{}'::jsonb,
  add column if not exists configuration_json jsonb not null default '{}'::jsonb,
  add column if not exists last_health_check_at timestamptz,
  add column if not exists last_success_at timestamptz,
  add column if not exists needs_reauthorization boolean not null default false;

alter table public.tasks add column if not exists idempotency_key text;
create unique index if not exists tasks_org_idempotency_uidx
  on public.tasks(organization_id, idempotency_key);

create unique index if not exists integration_connections_org_provider_global_uidx
  on public.integration_connections(organization_id, provider)
  where creator_id is null;
create unique index if not exists integration_connections_org_provider_creator_uidx
  on public.integration_connections(organization_id, provider, creator_id)
  where creator_id is not null;

create table if not exists public.integration_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  integration_connection_id uuid not null unique references public.integration_connections(id) on delete cascade,
  provider text not null,
  ciphertext text not null,
  initialization_vector text not null,
  auth_tag text not null,
  key_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.oauth_states (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  provider text not null check (provider in ('SLACK','NOTION')),
  state_hash text not null unique,
  redirect_uri text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists oauth_states_expiry_idx on public.oauth_states(expires_at)
  where consumed_at is null;

alter table public.integration_credentials enable row level security;
alter table public.oauth_states enable row level security;

revoke all on public.integration_credentials from public, anon, authenticated;
revoke all on public.oauth_states from public, anon, authenticated;
grant all on public.integration_credentials to service_role;
grant all on public.oauth_states to service_role;

create or replace function public.consume_oauth_state(
  p_state_hash text,
  p_provider text,
  p_user_id uuid,
  p_organization_id uuid
) returns table(redirect_uri text)
language plpgsql
security definer
set search_path=''
as $$
begin
  return query
  update public.oauth_states
  set consumed_at = now()
  where state_hash = p_state_hash
    and provider = p_provider
    and user_id = p_user_id
    and organization_id = p_organization_id
    and consumed_at is null
    and expires_at > now()
  returning oauth_states.redirect_uri;
end;
$$;

revoke all on function public.consume_oauth_state(text,text,uuid,uuid) from public, anon, authenticated;
grant execute on function public.consume_oauth_state(text,text,uuid,uuid) to service_role;

create table if not exists public.api_rate_limits (
  rate_key text primary key,
  request_count integer not null,
  reset_at timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.api_rate_limits enable row level security;
revoke all on public.api_rate_limits from public, anon, authenticated;
grant all on public.api_rate_limits to service_role;

create or replace function public.consume_api_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
) returns boolean
language plpgsql
security definer
set search_path=''
as $$
declare
  current_count integer;
begin
  insert into public.api_rate_limits(rate_key, request_count, reset_at)
  values (p_key, 1, now() + make_interval(secs => p_window_seconds))
  on conflict (rate_key) do update
  set request_count = case
        when public.api_rate_limits.reset_at <= now() then 1
        else public.api_rate_limits.request_count + 1
      end,
      reset_at = case
        when public.api_rate_limits.reset_at <= now() then now() + make_interval(secs => p_window_seconds)
        else public.api_rate_limits.reset_at
      end,
      updated_at = now()
  returning request_count into current_count;
  return current_count <= p_limit;
end;
$$;
revoke all on function public.consume_api_rate_limit(text,integer,integer) from public, anon, authenticated;
grant execute on function public.consume_api_rate_limit(text,integer,integer) to service_role;

-- A deployment-wide uniqueness fence prevents concurrent activation requests from
-- creating two unfinished runs for one creator and workflow definition.
create unique index if not exists workflow_runs_one_active_creator_definition_uidx
  on public.workflow_runs(organization_id, creator_id, definition_id)
  where creator_id is not null and status not in ('SUCCEEDED','CANCELLED');

commit;
