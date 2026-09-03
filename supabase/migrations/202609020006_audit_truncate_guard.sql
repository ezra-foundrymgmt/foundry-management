begin;

-- Migration 0001 blocks UPDATE and DELETE on audit_events with a row-level
-- trigger, but a row-level trigger never fires for TRUNCATE. Without this a
-- single `truncate public.audit_events` erases the entire immutable audit
-- trail, which is exactly the operation an attacker with service_role would
-- reach for. Statement-level TRUNCATE triggers close that gap.
create or replace function public.prevent_audit_truncate() returns trigger
  language plpgsql
  set search_path = ''
as $$ begin raise exception 'audit_events are append-only and cannot be truncated'; end $$;

drop trigger if exists audit_events_no_truncate on public.audit_events;
create trigger audit_events_no_truncate
  before truncate on public.audit_events
  for each statement execute function public.prevent_audit_truncate();

drop trigger if exists domain_events_no_truncate on public.domain_events;
create trigger domain_events_no_truncate
  before truncate on public.domain_events
  for each statement execute function public.prevent_audit_truncate();

commit;
