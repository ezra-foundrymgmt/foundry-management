begin;

-- Activation creates report schedules, but nothing executed them: the rows were
-- inert. A scheduler needs to know when a schedule is next due, when it last
-- ran, and what happened, or it cannot detect a missed run or avoid running the
-- same schedule twice.
alter table public.creator_report_schedules
  add column if not exists next_due_at timestamptz not null default now(),
  add column if not exists last_run_at timestamptz,
  add column if not exists last_status text,
  add column if not exists last_error text,
  add column if not exists consecutive_failures integer not null default 0;

-- The scheduler claims due schedules by this index rather than scanning.
create index if not exists creator_report_schedules_due_idx
  on public.creator_report_schedules (next_due_at)
  where active;

/**
 * A timezone name Postgres will accept, falling back to UTC.
 *
 * `at time zone '<garbage>'` raises. creator_report_schedules.timezone holds
 * whatever string the creator record carried, so without this one unrecognised
 * value would abort the claim for every schedule in the batch — a single bad
 * creator record silently stopping all reporting.
 */
-- STABLE, not IMMUTABLE: pg_timezone_names changes when the server's tzdata is
-- updated, so the result is only guaranteed constant within one statement.
create or replace function public.safe_timezone(p_timezone text)
  returns text
  language sql
  stable
  set search_path = ''
as $$
  select case
    when p_timezone is not null
      and exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_timezone)
    then p_timezone
    else 'UTC'
  end;
$$;

revoke all on function public.safe_timezone(text) from public, anon, authenticated;
grant execute on function public.safe_timezone(text) to service_role;

/**
 * Claims schedules that are due, advancing next_due_at in the same statement.
 *
 * Doing the claim and the advance atomically is what makes two overlapping
 * scheduler invocations safe: the second sees the already-advanced next_due_at
 * and picks up nothing. A read-then-write in application code would let both
 * invocations claim the same schedule and generate the report twice.
 *
 * FOR UPDATE SKIP LOCKED means a concurrent claim moves past a locked row
 * instead of blocking on it.
 *
 * The advance steps forward from the schedule's own next_due_at in whole
 * cadence intervals, not from p_now. Advancing from p_now would walk the
 * schedule later every time a run started a few minutes late, so a 09:00 report
 * would drift through the morning over a month. Stepping by
 * floor((now - due) / interval) + 1 keeps the time of day fixed and skips
 * whatever occurrences were missed while the scheduler was down — one catch-up
 * report, not a burst of backdated ones.
 *
 * The arithmetic is done on the local wall clock in the schedule's own timezone,
 * then converted back. Adding 86400 seconds is not the same as adding a day: at
 * a daylight-saving transition it shifts the creator's local time by an hour,
 * permanently, until the next transition undoes it. Converting to local time
 * first makes "+1 day" mean the same clock time tomorrow, which is what a
 * creator expects of their daily report.
 *
 * An unrecognised timezone falls back to UTC rather than raising. The column
 * holds whatever string the creator record carried, and one bad value must not
 * abort the claim for every other schedule in the batch.
 *
 * The "how many occurrences were missed" division is still in seconds, so on the
 * 23- or 25-hour day of a transition it can land one occurrence short and leave
 * next_due_at slightly in the past. The schedule is then claimed again on the
 * next hourly tick and settles. That costs one redundant run a year and produces
 * no duplicate report, because reports are upserted on (creator_id, report_date).
 *
 * last_run_at is stamped at claim time, not completion: the claim and the
 * advance have to be one statement, and the outcome is recorded separately by
 * record_report_schedule_result.
 */
create or replace function public.claim_due_report_schedules(
  p_now timestamptz,
  p_limit integer
) returns table (
  id uuid,
  organization_id uuid,
  creator_id uuid,
  cadence text,
  timezone text
)
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  return query
  with due as (
    select s.id
    from public.creator_report_schedules s
    where s.active and s.next_due_at <= p_now
    order by s.next_due_at
    limit greatest(p_limit, 1)
    for update skip locked
  )
  update public.creator_report_schedules s
     set next_due_at = (
           (
             (s.next_due_at at time zone public.safe_timezone(s.timezone))
             + make_interval(
                 days => (case when s.cadence = 'DAILY' then 1 else 7 end)
                   * (
                     floor(
                       extract(epoch from (p_now - s.next_due_at))
                       / (case when s.cadence = 'DAILY' then 86400 else 604800 end)
                     )::integer + 1
                   )
               )
           ) at time zone public.safe_timezone(s.timezone)
         ),
         last_run_at = p_now,
         updated_at = p_now
    from due
   where s.id = due.id
  returning s.id, s.organization_id, s.creator_id, s.cadence, s.timezone;
end $$;

revoke all on function public.claim_due_report_schedules(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.claim_due_report_schedules(timestamptz, integer)
  to service_role;

/**
 * Records the outcome of a scheduled run so failures are visible and countable.
 *
 * A failure pulls next_due_at back to a short exponential backoff so a
 * transient error is retried within the hour rather than silently costing the
 * creator a whole day's report. The retry is bounded: after
 * MAX_FAST_RETRIES consecutive failures the schedule falls back to its normal
 * cadence, so a permanently broken schedule does not retry forever. least()
 * guarantees the backoff can only ever pull the next run earlier, never push it
 * later than the cadence already decided.
 *
 * SKIPPED is not a failure. A creator with no frozen baseline has nothing to
 * report on yet; retrying in ten minutes would not change that, so it waits for
 * the next cadence like a success does.
 */
create or replace function public.record_report_schedule_result(
  p_schedule_id uuid,
  p_status text,
  p_error text
) returns void
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  max_fast_retries constant integer := 5;
  base_backoff constant interval := interval '10 minutes';
  failures integer;
begin
  update public.creator_report_schedules
     set last_status = p_status,
         last_error = p_error,
         consecutive_failures = case
           when p_status = 'FAILED' then consecutive_failures + 1
           else 0
         end,
         updated_at = now()
   where id = p_schedule_id
  returning consecutive_failures into failures;

  if p_status = 'FAILED' and failures is not null and failures <= max_fast_retries then
    update public.creator_report_schedules
       set next_due_at = least(
             next_due_at,
             now() + base_backoff * power(2, failures - 1)
           )
     where id = p_schedule_id;
  end if;
end $$;

revoke all on function public.record_report_schedule_result(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.record_report_schedule_result(uuid, text, text)
  to service_role;

commit;
