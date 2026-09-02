begin;

create table public.contracts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  prospect_id uuid references public.prospects(id),
  application_id uuid references public.creator_applications(id),
  creator_id uuid references public.creators(id),
  status text not null default 'DRAFT',
  management_model text,
  commission_percentage numeric(5,2),
  commission_basis text,
  sent_at timestamptz,
  signed_at timestamptz,
  starts_on date,
  ends_on date,
  document_reference text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index contracts_org_status_idx on public.contracts(organization_id,status);
create unique index creators_source_prospect_idx on public.creators(organization_id,source_prospect_id)
  where source_prospect_id is not null;

alter table public.contracts enable row level security;
create policy tenant_isolation on public.contracts for all to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));

revoke all on public.contracts from anon, authenticated;
grant select on public.contracts to authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

create or replace function public.convert_prospect_to_creator(
  p_prospect_id uuid,
  p_application_id uuid default null,
  p_contract_id uuid default null,
  p_actor_id uuid default auth.uid()
) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  prospect_row public.prospects%rowtype;
  creator_id uuid;
  correlation_id uuid := gen_random_uuid();
  event_id uuid;
begin
  select * into prospect_row
  from public.prospects
  where id = p_prospect_id and archived_at is null
  for update;

  if not found then raise exception 'PROSPECT_NOT_FOUND'; end if;

  select id into creator_id
  from public.creators
  where organization_id = prospect_row.organization_id
    and source_prospect_id = prospect_row.id;

  if creator_id is not null then return creator_id; end if;
  if prospect_row.pipeline_stage not in ('SIGNED','ACTIVATION') then
    raise exception 'PROSPECT_NOT_SIGNED';
  end if;
  if prospect_row.email is null then raise exception 'PROSPECT_EMAIL_REQUIRED'; end if;

  insert into public.creators (
    organization_id, preferred_name, stage_name, email, phone, country, region, timezone,
    start_date, status, contract_status, jurisdiction_review_status,
    adult_confirmation_status, primary_platform, baseline_revenue_range,
    source_prospect_id, source_application_id, created_by, updated_by
  ) values (
    prospect_row.organization_id, prospect_row.preferred_name, prospect_row.stage_name,
    prospect_row.email, prospect_row.phone, prospect_row.country, prospect_row.region,
    coalesce(prospect_row.timezone,'UTC'), current_date, 'ONBOARDING', 'SIGNED', 'PENDING',
    'NOT_STARTED', prospect_row.primary_social_platform, prospect_row.estimated_revenue_range,
    prospect_row.id, p_application_id, p_actor_id, p_actor_id
  ) returning id into creator_id;

  if p_application_id is not null then
    update public.creator_applications
    set associated_prospect_id = prospect_row.id, converted_creator_id = creator_id, updated_at = now()
    where id = p_application_id and organization_id = prospect_row.organization_id;
    if not found then raise exception 'APPLICATION_NOT_FOUND'; end if;
  end if;

  if p_contract_id is not null then
    update public.contracts
    set prospect_id = prospect_row.id, application_id = p_application_id, creator_id = creator_id,
        status = 'SIGNED', signed_at = coalesce(signed_at,now()), updated_at = now()
    where id = p_contract_id and organization_id = prospect_row.organization_id;
    if not found then raise exception 'CONTRACT_NOT_FOUND'; end if;
  end if;

  update public.prospects
  set pipeline_stage = 'ACTIVATION', updated_by = p_actor_id, updated_at = now()
  where id = prospect_row.id;

  insert into public.audit_events (
    organization_id, actor_type, actor_user_id, action, resource_type, resource_id,
    before_json, after_json, correlation_id
  ) values (
    prospect_row.organization_id, 'user', p_actor_id, 'prospect.converted', 'creator', creator_id,
    jsonb_build_object('prospect_id',prospect_row.id,'pipeline_stage',prospect_row.pipeline_stage),
    jsonb_build_object('creator_id',creator_id,'status','ONBOARDING'), correlation_id
  );

  insert into public.domain_events (
    organization_id, event_name, aggregate_type, aggregate_id, payload_json, correlation_id
  ) values (
    prospect_row.organization_id, 'creator.created', 'creator', creator_id,
    jsonb_build_object('creator_id',creator_id,'source_prospect_id',prospect_row.id), correlation_id
  ) returning id into event_id;

  insert into public.event_outbox (organization_id,domain_event_id,topic,payload_json)
  values (
    prospect_row.organization_id, event_id, 'creator.created',
    jsonb_build_object('creator_id',creator_id,'source_prospect_id',prospect_row.id)
  );

  return creator_id;
exception
  when unique_violation then
    select id into creator_id from public.creators
    where organization_id = prospect_row.organization_id and source_prospect_id = prospect_row.id;
    if creator_id is not null then return creator_id; end if;
    raise;
end;
$$;

revoke all on function public.convert_prospect_to_creator(uuid,uuid,uuid,uuid) from public;
grant execute on function public.convert_prospect_to_creator(uuid,uuid,uuid,uuid) to service_role;

commit;
