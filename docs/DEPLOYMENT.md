# Deployment

CreatorOS deploys to Vercel. Target topology:

```
Windows PWA / browser
  → Vercel (Next.js 16, apps/web)
      → Supabase (Postgres, Auth, RLS)
      → Inngest (durable workflows)
      → Slack / Notion
```

Status: **not deployed.** The Vercel project is linked
(`.vercel/project.json` → `creatoros`) but the CLI on this machine is not
authenticated and no deployment has been performed.

## Vercel project settings

**Root Directory: the repository root.** There is now exactly one
`vercel.json`, at the root; the second one under `apps/web` used a fragile
`cd ../..` and has been deleted, so there is nothing to conflict with.

Root `vercel.json`:

```json
{
  "framework": "nextjs",
  "installCommand": "pnpm install --frozen-lockfile",
  "buildCommand": "pnpm --filter @creatoros/web build",
  "outputDirectory": "apps/web/.next"
}
```

If you change Root Directory to `apps/web`, this file stops applying and the
build breaks — the workspace packages live above it.

## Environments

| | Local | Preview | Production |
| --- | --- | --- | --- |
| `APP_ENV` | `development` | `staging` | `production` |
| `VERCEL_ENV` | unset | `preview` | `production` |
| `CREATOROS_INTEGRATION_MODE` | `mock` | **`live`** | **`live`** |
| Supabase | local or staging | **staging** | production |

**Mock mode cannot be deployed.** It fabricates a super_admin session and
short-circuits the auth proxy, so `validate-env.mjs` fails the build and
`isMockMode()` throws at runtime whenever `VERCEL_ENV` is set or `APP_ENV` is
not `development`. A deploy that forgets `CREATOROS_INTEGRATION_MODE=live` fails
loudly instead of serving an open admin console.

### Keeping previews off production data

Set `PRODUCTION_SUPABASE_PROJECT_REF` to the production project ref
(`mqyvckazqawrqqsasomj`) in **all** environments. If a non-production deployment
is configured against that project, the build fails and
`createSupabaseAdminClient()` refuses to construct a service-role client.

This is the guard that matters: a preview URL is reachable by anyone with the
link, and the service role bypasses RLS.

## Environment variables

Set per environment in Vercel → Settings → Environment Variables. Never commit
values.

**Required in every deployed environment**

| Variable | Notes |
| --- | --- |
| `APP_ENV` | per the table above |
| `CREATOROS_INTEGRATION_MODE` | `live` |
| `NEXT_PUBLIC_APP_URL` | full https origin; may not contain `localhost` |
| `NEXT_PUBLIC_SUPABASE_URL` | project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | publishable key — browser-safe |
| `SUPABASE_SECRET_KEY` | server only. Legacy `SUPABASE_SERVICE_ROLE_KEY` is accepted |
| `INNGEST_EVENT_KEY` | |
| `INNGEST_SIGNING_KEY` | |
| `INTEGRATION_ENCRYPTION_KEY` | 32-byte base64; encrypts provider tokens at rest |
| `PRODUCTION_SUPABASE_PROJECT_REF` | production project ref, in every environment |

**Optional — features stay off without them**

| Variable | Enables |
| --- | --- |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` / `SLACK_REDIRECT_URI` | Slack install |
| `SLACK_SIGNING_SECRET` | Slack events and the agent |
| `NOTION_CLIENT_ID` / `NOTION_CLIENT_SECRET` / `NOTION_REDIRECT_URI` | Notion OAuth |
| `ANTHROPIC_API_KEY` | the Foundry agent |
| `FOUNDRY_AGENT_MODEL` | defaults to `claude-opus-5` |
| `SENTRY_DSN` | error reporting, when wired |

Generate the encryption key with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

**Rotating `INTEGRATION_ENCRYPTION_KEY` invalidates every stored provider
token.** Slack and Notion must both be reconnected afterwards.

## Deploy

```bash
npx vercel login
npx vercel link
npx vercel --prod
```

`prebuild` runs `validate-env.mjs`, so a misconfigured environment fails before
Next builds rather than deploying something unsafe.

## Post-deploy checks

1. `GET /api/health` → 200.
2. `/login` renders; an unauthenticated request to `/` redirects there.
   *(If it does not, `CREATOROS_INTEGRATION_MODE` is not `live`.)*
3. Sign in as Ezra; the avatar menu shows the real email and role.
4. `/manifest.webmanifest` and `/icons/512` return 200.
5. Install the PWA (`docs/PWA_INSTALL.md`).
6. Register the Inngest app against `https://<domain>/api/inngest`.
7. Connect Slack and Notion in Settings → Integrations.
8. Point the Slack app's Request URL at `https://<domain>/api/slack/events`.

## Rollback

Vercel → Deployments → pick the last good deployment → **Promote to
Production**. Application rollback does not roll back the database; migrations
are forward-only. See `docs/production-runbook.md`.
