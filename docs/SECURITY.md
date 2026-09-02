# Security

CreatorOS uses Supabase Auth for identity, organization membership for tenancy, explicit server-side RBAC for authorization, and Postgres RLS as defense in depth. Business-domain tables carry `organization_id`; creator-private data is never joined across tenants.

Provider secrets are server-only environment values. No raw platform passwords, SSNs, banking credentials, recovery passwords, KYC images, or tax IDs are stored. Ownership, KYC, payout, and recovery are represented only as operational statuses.

Mutation endpoints validate input, return safe errors, rate-limit sensitive actions, and emit audit records. Security headers restrict content types, referrers, browser capabilities, and connection origins. Audit events are append-only at the database layer and omit sensitive payloads. Soft archives preserve business history.

Critical security or compliance incidents hard-override creator health to `CRITICAL`. Incident response preserves correlation IDs, assigns an owner, records resolution and root cause, and produces follow-up work.
