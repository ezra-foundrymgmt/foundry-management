begin;

-- Linking a Slack user to a CreatorOS user was a manual SQL insert, which meant
-- the only record of who granted an agent identity was the person who ran the
-- statement. These columns let the mapping be administered and reviewed: what
-- Slack account it points at, when Slack last confirmed that account exists, and
-- which admin created the link.
alter table public.slack_user_identities
  add column if not exists slack_display_name text,
  add column if not exists last_verified_at timestamptz,
  add column if not exists linked_by_user_id uuid references public.users(id) on delete set null;

commit;
