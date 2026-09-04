begin;

-- The timezone activation gate could never fail.
--
-- convert_prospect_to_creator defaulted timezone to 'UTC' whenever the prospect
-- had none, which is always: the prospect form has no timezone field. So the
-- gate passed unconditionally AND the rest of the system was told every creator
-- lives in UTC. That is not cosmetic -- the report scheduler dates each
-- creator's daily report in their own timezone, and the revenue planner counts
-- elapsed days the same way, so a Los Angeles creator was measured on a day
-- boundary eight hours off.
--
-- It now stores the 'UNSET' sentinel, deliberately not a valid IANA name:
-- reportDateFor already falls back to UTC for anything unparseable, so
-- behaviour is unchanged while the gate can finally see the gap. A new
-- control on Creator 360 is where a real zone gets recorded.
--
-- contract_status is deliberately LEFT as 'SIGNED'. An earlier draft of this
-- migration changed it to 'PENDING' on the theory that the gate was asserting a
-- contract nobody had checked. That was wrong: the guard above this insert
-- already refuses to convert a prospect whose pipeline_stage is not SIGNED or
-- ACTIVATION, so the value is a faithful copy of a human assertion rather than
-- a fabrication. Demoting it would have forced the same person to mark the same
-- fact twice for no added safety.
--
-- Existing rows are not rewritten; a creator already carrying a real timezone
-- keeps it.

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
  v_creator_id uuid;
  correlation_id uuid := gen_random_uuid();
  event_id uuid;
begin
  select * into prospect_row
  from public.prospects
  where id = p_prospect_id and archived_at is null
  for update;

  if not found then raise exception 'PROSPECT_NOT_FOUND'; end if;

  select creators.id into v_creator_id
  from public.creators as creators
  where creators.organization_id = prospect_row.organization_id
    and creators.source_prospect_id = prospect_row.id;

  if v_creator_id is not null then return v_creator_id; end if;
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
    coalesce(nullif(prospect_row.timezone,''),'UNSET'), current_date, 'ONBOARDING', 'SIGNED', 'PENDING',
    'NOT_STARTED', prospect_row.primary_social_platform, prospect_row.estimated_revenue_range,
    prospect_row.id, p_application_id, p_actor_id, p_actor_id
  ) returning id into v_creator_id;

  if p_application_id is not null then
    update public.creator_applications as applications
    set associated_prospect_id = prospect_row.id,
        converted_creator_id = v_creator_id,
        updated_at = now()
    where applications.id = p_application_id
      and applications.organization_id = prospect_row.organization_id;
    if not found then raise exception 'APPLICATION_NOT_FOUND'; end if;
  end if;

  if p_contract_id is not null then
    update public.contracts as contracts
    set prospect_id = prospect_row.id,
        application_id = p_application_id,
        creator_id = v_creator_id,
        status = 'SIGNED',
        signed_at = coalesce(contracts.signed_at,now()),
        updated_at = now()
    where contracts.id = p_contract_id
      and contracts.organization_id = prospect_row.organization_id;
    if not found then raise exception 'CONTRACT_NOT_FOUND'; end if;
  end if;

  update public.prospects as prospects
  set pipeline_stage = 'ACTIVATION', updated_by = p_actor_id, updated_at = now()
  where prospects.id = prospect_row.id;

  insert into public.audit_events (
    organization_id, actor_type, actor_user_id, action, resource_type, resource_id,
    before_json, after_json, correlation_id
  ) values (
    prospect_row.organization_id, 'user', p_actor_id, 'prospect.converted', 'creator', v_creator_id,
    jsonb_build_object('prospect_id',prospect_row.id,'pipeline_stage',prospect_row.pipeline_stage),
    jsonb_build_object('creator_id',v_creator_id,'status','ONBOARDING'), correlation_id
  );

  insert into public.domain_events (
    organization_id, event_name, aggregate_type, aggregate_id, payload_json, correlation_id
  ) values (
    prospect_row.organization_id, 'creator.created', 'creator', v_creator_id,
    jsonb_build_object('creator_id',v_creator_id,'source_prospect_id',prospect_row.id), correlation_id
  ) returning id into event_id;

  insert into public.event_outbox (organization_id,domain_event_id,topic,payload_json)
  values (
    prospect_row.organization_id, event_id, 'creator.created',
    jsonb_build_object('creator_id',v_creator_id,'source_prospect_id',prospect_row.id)
  );

  return v_creator_id;
exception
  when unique_violation then
    select creators.id into v_creator_id
    from public.creators as creators
    where creators.organization_id = prospect_row.organization_id
      and creators.source_prospect_id = prospect_row.id;
    if v_creator_id is not null then return v_creator_id; end if;
    raise;
end;
$$;

revoke all on function public.convert_prospect_to_creator(uuid,uuid,uuid,uuid) from public;
grant execute on function public.convert_prospect_to_creator(uuid,uuid,uuid,uuid) to service_role;

commit;
