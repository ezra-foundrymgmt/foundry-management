begin;

-- Creator intake: the missing half of the creator profile.
--
-- CreatorOS was built around a creator profile nobody could fill in. Six tables
-- exist for it and five of them have never held real content:
--
--   creator_brand_profiles   one row per creator, all 23 content columns NULL,
--                            written once by initializeBrandProfile and never
--                            again (apps/web/src/lib/activation-records.ts).
--   creator_truth_items      zero rows, zero lines of application code.
--   creator_competitors      zero rows; the activation step named after it
--                            deliberately writes a task instead.
--   content_franchises       zero references outside this schema.
--   content_pillars          three rows per creator from a hardcoded literal,
--                            identical for every creator.
--   creators.country/.region/.baseline_revenue_range
--                            copied at conversion from prospect columns that
--                            nothing writes, so NULL on every creator.
--
-- The agency already had the instrument that collects this -- a Google Form,
-- "Foundry MGMT Model Information Sheet" -- with no way to get its answers into
-- the system. This migration is the landing ground for it.
--
-- WHAT THIS DELIBERATELY DOES NOT DO: it does not tighten the activation gates
-- that assert a Brand Dossier and a Content Test Board exist. Those gates count
-- rows (activation-readiness.ts), and the rows they count are manufactured by
-- the activation run itself -- INITIALIZE_BRAND_PROFILE, CREATE_CONTENT_TEST_BOARD
-- and COMPLETE_ACTIVATION are steps in the SAME run, and completeActivation
-- throws CREATOR_NOT_READY_FOR_ACTIVE unless every check passes. Making either
-- gate content-sensitive before a writer exists would make every activation
-- fail at its own last step, permanently. The writer comes first; the gates are
-- tightened afterwards, in their own migration, once there is something that
-- can satisfy them.

-- ---------------------------------------------------------------------------
-- The per-creator reference code that ties a form response to a creator.
-- ---------------------------------------------------------------------------
--
-- This code is a CORRELATOR, not a credential, and the schema says so by
-- storing it in plain text.
--
-- Google Forms has no hidden and no read-only field. A prefilled value arrives
-- as a visible `entry.583367904=<code>` URL parameter which the respondent can
-- read, edit, clear or forward. Storing a hash of it would imply a secrecy the
-- transport cannot provide, and would stop an operator reading a code off a
-- submission to match it by hand -- which is exactly the recovery path for a
-- creator who cleared the box.
--
-- Authorisation lives elsewhere and is unaffected by anyone forging a code: a
-- submission can only advance a creator whose activation run an authenticated
-- operator already started and which is already parked waiting for intake.
-- A forged code can at worst attach reviewable data to a real creator, which
-- an operator then rejects.
create table public.creator_intake_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  creator_id uuid not null references public.creators(id),
  -- Human-readable on purpose: it appears in a form a creator reads, so it is
  -- shaped like a reference number (CR-000016-7KQ2) rather than a random
  -- string, while the suffix keeps a stray submission from landing on the
  -- wrong creator by accident.
  reference_code text not null,
  issued_by uuid,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  -- Set when a submission is APPLIED, not when one arrives. A creator who
  -- fills the form twice because the first attempt was wrong must not be
  -- locked out by her own first try.
  redeemed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, reference_code)
);

create index if not exists creator_intake_links_creator_idx
  on public.creator_intake_links (creator_id, issued_at desc);

-- ---------------------------------------------------------------------------
-- What actually came back from the form.
-- ---------------------------------------------------------------------------
create table public.creator_intake_submissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  -- Nullable: a submission whose reference code matches nothing is still a real
  -- submission and must be storable. Attributing it to a guessed creator would
  -- be the "unknown became a value" failure this codebase exists to avoid.
  creator_id uuid references public.creators(id),
  intake_link_id uuid references public.creator_intake_links(id),
  provider text not null default 'GOOGLE_FORMS',
  external_response_id text not null,
  external_form_id text,
  -- SHA-256 of the normalised answer set. Part of the idempotency key; see the
  -- index below for why the response id alone is not enough.
  content_hash text not null,
  -- Exactly what the respondent had in the box, kept even when it matches
  -- nothing, so an operator can see what she typed.
  reference_code_submitted text,
  respondent_email text,
  submitted_at timestamptz not null,
  received_at timestamptz not null default now(),
  -- PENDING_REVIEW -> APPLIED | REJECTED | SUPERSEDED. Nothing reaches a
  -- creator record without passing through APPLIED.
  status text not null default 'PENDING_REVIEW'
    check (status in ('PENDING_REVIEW', 'APPLIED', 'REJECTED', 'SUPERSEDED', 'UNMATCHED')),
  /**
   * The submission exactly as it arrived, before any mapping.
   *
   * This is the record of what the creator actually stated -- including the
   * question wording she read. A boundary she asserted is the kind of thing
   * that gets disputed later, and a mapped column cannot show which question
   * produced it. The mapped view is derived and disposable; this is not.
   */
  raw_payload_json jsonb not null,
  mapped_json jsonb not null default '{}'::jsonb,
  /**
   * Questions the mapper did not recognise, preserved rather than dropped.
   *
   * Someone will add a question to the form and tell nobody. Silently ignoring
   * it would mean a creator answers a question and the answer evaporates; this
   * makes that visible instead.
   */
  unrecognized_json jsonb not null default '[]'::jsonb,
  applied_at timestamptz,
  applied_by uuid,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

/**
 * Idempotency, keyed on the response AND its content.
 *
 * Google Forms fires its trigger for new AND updated responses, and an edited
 * response keeps its original responseId. Keying on responseId alone would
 * silently swallow a creator's correction; keying on nothing would let a
 * transport retry duplicate it.
 *
 * Including the content hash gives both: a redelivery of identical content
 * collides and is a no-op, while an edit lands as a new row for review. It is
 * then the reviewer -- not the transport -- who decides whether an edit that
 * arrives after APPLIED changes anything.
 *
 * Non-partial and on plain columns, following 202609040015: PostgREST supplies
 * no WHERE clause on upsert, so a partial index raises 42P10, and its
 * on_conflict target accepts column names only, never an expression.
 */
create unique index if not exists creator_intake_submissions_response_uidx
  on public.creator_intake_submissions (provider, external_response_id, content_hash);

create index if not exists creator_intake_submissions_review_idx
  on public.creator_intake_submissions (organization_id, status, received_at desc);

-- ---------------------------------------------------------------------------
-- Somewhere to put the four answers that have no home in the schema today.
-- ---------------------------------------------------------------------------
--
-- Age is deliberately NOT among these. It belongs to the adult-confirmation
-- record, which creator_compliance_checks already models correctly
-- (check_type, status, evidence_reference, reviewed_by, reviewed_at,
-- expires_at, unique(creator_id, check_type)) and which nothing has ever
-- written. Duplicating a date of birth onto creators would spread identity data
-- across two tables for no gain.
alter table public.creator_brand_profiles
  add column if not exists languages text[],
  add column if not exists content_days_per_week integer,
  add column if not exists preferred_shooting_times text,
  add column if not exists creator_goals text;

comment on column public.creator_brand_profiles.creator_goals is
  'What the creator says she wants from the platform, in her own words. Read by the revenue planner as context, never as a target CreatorOS invented.';

-- ---------------------------------------------------------------------------
-- Natural keys, so re-applying a submission corrects rather than duplicates.
-- ---------------------------------------------------------------------------
--
-- Neither table has any unique constraint today. creator_boundaries is written
-- by a real human form, so a second application of the same intake would give
-- a creator two identical hard boundaries; creator_truth_items has never been
-- written at all and would acquire the same defect on its first use.
--
-- A plain nullable column rather than an expression index, for two reasons:
-- PostgREST's on_conflict takes column names, and NULLS DISTINCT means a
-- hand-created boundary (which carries no intake_key) never collides with
-- anything -- so the operator's own entries are untouched by this.
alter table public.creator_boundaries add column if not exists intake_key text;
alter table public.creator_truth_items add column if not exists intake_key text;

create unique index if not exists creator_boundaries_intake_uidx
  on public.creator_boundaries (creator_id, intake_key);
create unique index if not exists creator_truth_items_intake_uidx
  on public.creator_truth_items (creator_id, intake_key);

-- ---------------------------------------------------------------------------
-- Which form belongs to this organisation.
-- ---------------------------------------------------------------------------
--
-- A submission whose reference code matches nothing still has a known tenant:
-- the form itself belongs to exactly one organisation. Resolving the org from
-- the form id rather than from the code is what lets an unmatched submission be
-- stored and reviewed instead of discarded.
--
-- Bootstrapped here the way 202609020005 and 202609040017 bootstrap other
-- organisation configuration, and idempotent: an organisation that already has
-- a form id keeps it.
update public.organizations
set settings_json = jsonb_set(
      coalesce(settings_json, '{}'::jsonb),
      '{intakeFormId}',
      '"1FAIpQLSeWmuyF-jLBB8OPM9NgYMl53EYR3EApHLY_U5qawxuORo3FKg"'::jsonb,
      true
    ),
    updated_at = now()
where settings_json->'intakeFormId' is null;

-- ---------------------------------------------------------------------------
-- Access. Service role only, following 202609020003 and 202609020007.
-- ---------------------------------------------------------------------------
--
-- 202609020001 grants `select on all tables` to authenticated, and both tables
-- here are created after that statement ran -- but the rule this codebase
-- settled on in 202609020012 is that nothing reaches a client directly, and
-- these two hold the sharpest data in the system: a raw payload containing a
-- creator's stated age, her hard limits, and the email she submitted from.
-- Revoked explicitly rather than relying on creation order.
revoke all on public.creator_intake_links from public, anon, authenticated;
revoke all on public.creator_intake_submissions from public, anon, authenticated;
grant all on public.creator_intake_links to service_role;
grant all on public.creator_intake_submissions to service_role;

alter table public.creator_intake_links enable row level security;
alter table public.creator_intake_submissions enable row level security;

commit;
