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

Required Slack bot scopes are `channels:manage`, `channels:read`, `groups:write`, `groups:read`, `chat:write`, and `users:read`. No message-history scope is requested.

Notion OAuth redirect URLs:

- staging: `https://<staging-domain>/api/integrations/notion/callback`
- production: `https://<production-domain>/api/integrations/notion/callback`

After OAuth, share one non-sensitive parent page with the integration and save its page ID in CreatorOS. CreatorOS projects only creator-hub and internal operating summaries beneath this parent.

## Inngest

Register `https://<domain>/api/inngest` in the matching Inngest environment. Configure the Event Key and current Signing Key. During key rotation, place the prior key in `INNGEST_SIGNING_KEY_FALLBACK`, deploy, rotate, verify, then remove the fallback.

Creator activation uses both an event ID and a function idempotency expression. Workflow runs, steps, and provisioned resource keys persist in Postgres; Inngest retries resume succeeded steps instead of replaying them.

## Vercel

Create a Vercel project with Root Directory `apps/web`. The checked-in `vercel.json` installs from the workspace root and builds only `@creatoros/web`. Configure environment values in Vercel rather than files. Add the custom domain only after the preview deployment passes all gates.

## PWA installation

CreatorOS publishes a web manifest, 192px and 512px branded icons, and a minimal service worker that caches only public PWA assets—never authenticated pages or API responses. On Chrome or Edge, open the HTTPS deployment and choose **Install CreatorOS** from the browser menu. Each partner signs in with their own account.

## Rotation and rollback

Rotate every credential that has appeared in chat or terminal history before production cutover. Provider credential rows are encrypted, but the source credentials must still be treated as exposed. Roll back application code through Vercel. Do not roll back schema by deleting production data; apply a forward corrective migration.
