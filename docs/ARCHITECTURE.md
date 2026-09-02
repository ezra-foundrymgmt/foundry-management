# CreatorOS architecture

CreatorOS is a modular monolith: one Next.js application, one canonical Postgres database, and bounded TypeScript packages. This keeps transactions and operations straightforward while preserving seams for future scale.

## Layers

1. The web layer renders operational views with server-first data access and exposes validated mutation endpoints.
2. Domain services own fit scoring, health scoring, creator-relative normalization, diagnostics, economics, and permissions.
3. Workflow services execute deterministic definitions and persist each step, attempt, error, and external resource.
4. Provider adapters translate domain operations into Slack, Notion, Google, social, revenue, or intelligence calls.
5. Postgres is the canonical record. Slack and Notion are projections; source platforms remain source metrics.

## Data and tenancy

Every business row is owned by an organization. RLS checks the authenticated user's active organization membership. Server authorization still checks explicit permissions; RLS is a second boundary, not a substitute. Creator IDs are UUIDs with immutable human identifiers such as `CR-000001`.

## Events and workflows

Domain writes can append `domain_events` and a matching `event_outbox` record in the same transaction. A future Inngest dispatcher consumes unpublished outbox records. `CREATOR_ACTIVATION_V1` is a 26-step deterministic workflow with creator-scoped locking, run idempotency, per-step idempotency, retry state, and external-wait states.

## Audit and observability

Important writes append structured `audit_events` with actor, action, resource, correlation ID, and optional workflow run. A database trigger prevents update/delete of audit rows. Logs must use correlation IDs and exclude secret or prohibited personal values.
