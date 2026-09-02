# Database

The initial migration creates 50+ Postgres tables grouped below.

- Identity: `organizations`, `users`, `organization_memberships`, `custom_roles`.
- CRM: `prospects`, `prospect_activities`, `creator_applications`.
- Creator core: `creators`, `creator_brand_profiles`, `creator_truth_items`, `creator_boundaries`.
- Content: `content_pillars`, `content_franchises`, `creator_competitors`, `creative_patterns`, `experiments`, `content_requests`, `content_assets`, `content_inventory_snapshots`, `social_accounts`, `social_posts`.
- Funnel and revenue: `tracking_links`, `landing_events`, `creator_revenue_daily`, `creator_pnl_periods`, `traffic_campaigns`, `creator_collaborations`.
- Operations: `tasks`, `creator_deliverables`, `creator_execution_scores`, `creator_health_scores`, `creator_relationship_checkins`, `meetings`, `incidents`, `creator_compliance_checks`, `capacity_snapshots`.
- Workflows and integrations: `workflow_definitions`, `workflow_runs`, `workflow_steps`, `provisioned_resources`, `integration_connections`, `tool_definitions`.
- Reporting and imports: `daily_creator_reports`, `weekly_creator_reports`, `monthly_business_reviews`, `creator_baselines`, `data_import_runs`.
- Platform: `notifications`, `audit_events`, `domain_events`, `event_outbox`.

Human identifiers use database sequences while UUIDs remain primary keys. Composite unique constraints protect creator numbers, imports, active workflow keys, workflow steps, and provisioned resources. Indexes support portfolio, report, task, audit, revenue, workflow, and outbox access patterns. RLS is enabled on every tenant table.
