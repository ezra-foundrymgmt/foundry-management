begin;

-- CreatorOS could report a creator's health but not record what Foundry had
-- decided to *do* about it. There was no creator-level priority anywhere:
-- `tasks`, `content_requests` and `daily_creator_reports` each carry a
-- `priority`, but the creator themselves did not, so "Madison is our critical
-- creator this week" lived only in someone's head and no audit entry could
-- attribute the decision to a person.
--
-- Nullable on purpose. A creator with no priority set is a creator nobody has
-- triaged yet, and that is worth being able to see. Backfilling every existing
-- creator with an invented 'MEDIUM' would assert a decision no one made, the
-- same reason initializeHealth writes band UNKNOWN rather than a fabricated
-- score.
--
-- Plain text, not an enum, matching its siblings (`tasks.priority`,
-- `contract_status`, `jurisdiction_review_status`). The permitted values live in
-- WORK_PRIORITIES in @creatoros/domain and are enforced by zod at the write
-- surface, which is where every other text status in this schema is validated.
alter table public.creators
  add column if not exists priority text;

-- The triage read: open the creator list ordered by what needs attention, within
-- one tenant, excluding archived records. Matches the shape of
-- creators_org_status_idx.
create index if not exists creators_org_priority_idx
  on public.creators (organization_id, priority)
  where archived_at is null;

commit;
