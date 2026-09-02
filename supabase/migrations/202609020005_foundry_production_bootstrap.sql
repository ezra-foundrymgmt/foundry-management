begin;

insert into public.organizations (id, name, slug, settings_json)
values (
  '00000000-0000-4000-8000-000000000001',
  'Foundry Management',
  'foundry',
  '{"demo_mode":false,"content_buffer":{"target":14,"warning":10,"critical":7}}'::jsonb
)
on conflict (id) do update
set name = excluded.name,
    slug = excluded.slug,
    settings_json = excluded.settings_json,
    updated_at = now();

insert into public.workflow_definitions (id, organization_id, name, version, description, steps_json)
values
  (
    '30000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000001',
    'CREATOR_ACTIVATION_V1',
    1,
    'Deterministic creator activation workflow',
    '[]'::jsonb
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
    'CREATOR_OFFBOARDING_V1',
    1,
    'Manual-first access revocation and archive sequence',
    '["VALIDATE_OFFBOARDING_APPROVAL","REVOKE_FOUNDRY_ACCESS","DISCONNECT_INTEGRATIONS","PREPARE_PERMITTED_DATA_EXPORT","ARCHIVE_OPEN_TASKS","ARCHIVE_NOTION_PROJECTIONS","ARCHIVE_SLACK_CHANNELS","REQUEST_FINAL_FINANCIAL_RECONCILIATION","MARK_CREATOR_FORMER"]'::jsonb
  )
on conflict (organization_id, name, version) do update
set description = excluded.description,
    steps_json = excluded.steps_json,
    active = true;

insert into public.tool_definitions (
  organization_id, name, version, description, risk_level, required_permission, requires_human_approval
)
values
  ('00000000-0000-4000-8000-000000000001', 'search_creator', 1, 'Search tenant-scoped creator records', 0, 'creator.read', false),
  ('00000000-0000-4000-8000-000000000001', 'start_creator_onboarding', 1, 'Start deterministic creator activation', 2, 'workflow.start', true),
  ('00000000-0000-4000-8000-000000000001', 'create_internal_task', 1, 'Create a low-risk internal task', 1, 'task.create', false)
on conflict (organization_id, name, version) do update
set description = excluded.description,
    risk_level = excluded.risk_level,
    required_permission = excluded.required_permission,
    requires_human_approval = excluded.requires_human_approval,
    enabled = true;

commit;
