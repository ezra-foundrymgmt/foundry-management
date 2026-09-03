# CreatorOS V1 production runbook

CreatorOS is the canonical operational system. Slack and Notion are replaceable projections; no provider token or provider-only state is exposed to the browser.

## Environment separation

Create separate Supabase and Inngest environments for staging and production. In Vercel, create separate Preview and Production values from `.env.staging.example` and `.env.production.example`. Never copy production database credentials into Preview. The build fails when a Vercel Preview declares `APP_ENV=production`, or when a production deployment does not.

Generate `INTEGRATION_ENCRYPTION_KEY` as 32 random bytes encoded in base64. Store it only in the deployment secret manager. Losing this key makes stored provider tokens unrecoverable; changing it requires reconnecting providers or a controlled re-encryption migration.

## Database deployment

1. Link the Supabase CLI to the intended project.
2. Confirm the project reference and environment in the terminal before applying anything.
3. Run `supabase db push` from the repository root. Migrations must apply in numeric order on a fresh project.
4. Do not run `supabase/seed.sql` in staging or production. It contains fictional local-preview data.
5. Create the Foundry organization, then create one Supabase Auth user per person. Insert matching rows into `public.users` and `public.organization_memberships`. Ezra and Payton must have separate accounts; grant `super_admin` only after confirming their exact email addresses.
6. Run the authorization verification suite before onboarding real creator data.

## Provider setup

Slack OAuth redirect URLs:

- staging: `https://<staging-domain>/api/integrations/slack/callback`
- production: `https://<production-domain>/api/integrations/slack/callback`

Required Slack bot scopes for channel provisioning are `channels:manage`, `channels:read`, `groups:write`, `groups:read`, `chat:write`, and `users:read`.

The Foundry agent additionally needs `app_mentions:read`, `im:read`, `im:write`, and `im:history`. `im:history` is a genuine expansion of access and is required only for direct messages — the agent reads the message text Slack delivers in the event payload and never calls a history API. Omit it if you do not want DM support; `@Foundry` mentions in channels still work.

Notion OAuth redirect URLs:

- staging: `https://<staging-domain>/api/integrations/notion/callback`
- production: `https://<production-domain>/api/integrations/notion/callback`

After OAuth, share one non-sensitive parent page with the integration and save its page ID in CreatorOS. CreatorOS projects only creator-hub and internal operating summaries beneath this parent.

## Inngest

Register `https://<domain>/api/inngest` in the matching Inngest environment. Configure the Event Key and current Signing Key. During key rotation, place the prior key in `INNGEST_SIGNING_KEY_FALLBACK`, deploy, rotate, verify, then remove the fallback.

Creator activation uses both an event ID and a function idempotency expression. Workflow runs, steps, and provisioned resource keys persist in Postgres; Inngest retries resume succeeded steps instead of replaying them.

## Vercel

Set Root Directory to the **repository root**, not `apps/web`. There is one `vercel.json`, at the root; it installs the workspace and builds only `@creatoros/web` with `outputDirectory` `apps/web/.next`. Pointing Root Directory at `apps/web` puts the workspace packages above the build root and breaks it. Configure environment values in Vercel rather than files. Add the custom domain only after the preview deployment passes all gates.

Set `PRODUCTION_SUPABASE_PROJECT_REF` in every environment. Any deployment that is not genuinely production and resolves to that project fails `validate-env.mjs` and refuses to construct a service-role client, which is what keeps a branch preview from mutating real creator records.

## PWA installation

CreatorOS publishes a web manifest, 192px and 512px branded icons, and a minimal service worker that caches only public PWA assets—never authenticated pages or API responses. On Chrome or Edge, open the HTTPS deployment and choose **Install CreatorOS** from the browser menu. Each partner signs in with their own account.

## Rotation and rollback

Rotate every credential that has appeared in chat or terminal history before production cutover. Provider credential rows are encrypted, but the source credentials must still be treated as exposed. Roll back application code through Vercel. Do not roll back schema by deleting production data; apply a forward corrective migration.

## Recovery

**None of these procedures has been rehearsed.** They are written from how the system is built, not from a drill. Treat the first real incident as the rehearsal, and correct this file afterwards.

### Bad application deploy

Vercel → Deployments → last known good → **Promote to Production**. Code rollback does not roll back the database; migrations are forward-only. If the bad deploy also shipped a migration, write a corrective migration rather than reverting the schema.

### Database problem

Supabase point-in-time recovery is whatever the project's plan provides — **confirm what your plan actually retains before you need it.** There is no CreatorOS-managed backup. For a bad data change rather than a lost database, prefer a targeted corrective UPDATE: `audit_events` is append-only and will show who changed what and under which correlation id.

### Integration outage (Slack or Notion down)

Activation steps fail and the run is marked FAILED with the failing step and error recorded. External resources already provisioned keep their ids. Recover with `POST /api/workflows/resume` once the provider is back; completed steps are skipped and only the failed step retries. No manual cleanup is needed.

### Lost Slack authorization

A revoked token makes health checks set `needs_reauthorization`, which makes the stored token unusable — deliberately, so nothing keeps trying with a dead credential. Recover through **Settings → Integrations → Slack → Reauthorize**. The new bot token replaces the old row. A merely DEGRADED connection (a transient failure) stays usable and recovers on its own.

### Notion page deleted

Page ids live in `provisioned_resources`. If someone deletes a creator hub in Notion, the stored id now points at nothing and updates fail. Delete that `provisioned_resources` row for the creator's `creator:<id>:notion:creator-hub:v1` key, then resume activation; a fresh hub is created and the new id stored. Do not edit the id by hand.

### Workflow stuck

Check `workflow_runs` for the creator. `WAITING_EXTERNAL` means baseline data has not arrived — that is correct behaviour, not a fault. `FAILED` means a step errored; read `workflow_steps.error_message`, fix the cause, then resume. Only one non-terminal run per creator can exist, so a stuck run must be resumed or cancelled before a new one can start.

### Accidental record change

Query `audit_events` filtered by `resource_id` and `created_at` to establish who changed what. The table is append-only: UPDATE and DELETE raise, and TRUNCATE is blocked by a statement-level trigger, so the trail cannot be edited to hide a change — including by anything holding the service role.
