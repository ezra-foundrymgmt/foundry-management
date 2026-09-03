begin;

-- One Slack or Notion workspace may belong to exactly one organization.
--
-- Without this, anyone holding integration.manage in organization B who is also
-- a member of organization A's Slack workspace could install the app from B.
-- That produced a second CONNECTED row with the same external_account_id, and
-- resolveSlackWorkspace uses maybeSingle(), which returns null when two rows
-- match — silently blackholing organization A's entire Slack ingress.
create unique index if not exists integration_connections_provider_workspace_uidx
  on public.integration_connections (provider, external_account_id)
  where creator_id is null and external_account_id is not null;

-- Agent-created content requests need the same idempotency fence tasks already
-- have: a retried agent turn re-runs the whole model loop, and an unkeyed insert
-- files the same request again on every retry.
alter table public.content_requests add column if not exists idempotency_key text;
create unique index if not exists content_requests_org_idempotency_uidx
  on public.content_requests (organization_id, idempotency_key)
  where idempotency_key is not null;

-- Agent transcripts contain whatever the asker's role was allowed to retrieve,
-- including revenue and integration detail. Making them readable by every member
-- of the organization would let a contractor read answers the tool gate would
-- never have produced for them: the transcript becomes a way around the
-- per-role permission check.
--
-- Readable by the person who asked. Everyone else goes through a server route
-- that re-checks permission.
drop policy if exists tenant_isolation on public.agent_interactions;
create policy own_agent_transcripts on public.agent_interactions
  for select to authenticated
  using (
    public.is_organization_member(organization_id)
    and user_id = (select auth.uid())
  );

commit;
