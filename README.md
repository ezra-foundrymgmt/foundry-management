# CreatorOS

CreatorOS is Foundry Management's internal operating system for creator
acquisition, onboarding, operations, content intelligence, performance
reporting, unit economics, and integration health. It is built around one
canonical record, tenant isolation, least privilege, explainable rules, and
deterministic workflows.

**Read [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md) before relying on
anything here.** Nothing in CreatorOS has been verified against live Supabase,
Inngest, Slack, Notion, Vercel, or the Anthropic API. It is not deployed.

## Layout

- `apps/web` — Next.js 16 App Router application and server endpoints
- `packages/domain` — scores, diagnostics, permission rules, fictional demo data
- `packages/workflows` — resumable `CREATOR_ACTIVATION_V1` orchestration
- `packages/integrations` — Slack, Notion, file, revenue and intelligence providers
- `supabase` — migrations, RLS, and deterministic seed data
- `docs` — setup, security, architecture, and decision records

## Local setup

Node 22+, Corepack/pnpm. Docker only for local Supabase.

```bash
corepack enable
pnpm install
cp .env.example .env.local
pnpm dev
```

Open `http://localhost:3000`. Local development runs in **mock mode**: no
Supabase, Slack, Notion, or model credentials are required, and the UI renders
fictional data with an explicit demo banner.

Blank values in `.env.local` are treated as unset, so copying `.env.example`
verbatim works.

### Mock mode cannot be deployed

Mock mode fabricates a `super_admin` session and short-circuits the auth proxy.
It is safe on a laptop and catastrophic on a URL. `validate-env.mjs` fails the
build and `isMockMode()` throws at runtime whenever `VERCEL_ENV` is set or
`APP_ENV` is anything but `development`. Deployments must set
`CREATOROS_INTEGRATION_MODE=live`.

## Commands

```bash
pnpm dev            # development server
pnpm build          # production build (runs the environment contract check first)
pnpm lint           # lint all workspaces
pnpm typecheck      # strict TypeScript
pnpm test           # unit, integration, security and failure-drill tests
pnpm test:e2e       # Playwright (run `pnpm --filter @creatoros/web exec playwright install chromium` once)
pnpm db:start       # local Supabase
pnpm db:reset       # replay migrations and seed
pnpm --filter @creatoros/web verify:live   # adversarial cross-tenant check, needs live credentials
```

## Authentication and data

Production uses Supabase Auth with Postgres RLS. `is_organization_member()` is a
`security definer` function resolving through `auth.uid()`, applied as a tenant
predicate across 50 tables; a client cannot forge membership. Browser roles hold
`select` only — every write goes through a server route that checks permission
and organization ownership first.

Each Foundry user needs their own account. See
[`docs/SUPABASE_SETUP.md`](docs/SUPABASE_SETUP.md).

## Documentation

| Document                                                                                                                                   | Covers                             |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| [Known limitations](docs/KNOWN_LIMITATIONS.md)                                                                                             | what does not work, stated plainly |
| [Architecture](docs/ARCHITECTURE.md) · [Database](docs/DATABASE.md) · [Domain model](docs/DOMAIN_MODEL.md)                                 | design                             |
| [Security](docs/SECURITY.md) · [Integration security](docs/INTEGRATION_SECURITY.md) · [Authorization matrix](docs/authorization-matrix.md) | security                           |
| [Supabase](docs/SUPABASE_SETUP.md) · [Inngest](docs/INNGEST_SETUP.md) · [Slack](docs/SLACK_SETUP.md) · [Notion](docs/NOTION_SETUP.md)      | integration setup                  |
| [Deployment](docs/DEPLOYMENT.md) · [PWA install](docs/PWA_INSTALL.md) · [Production runbook](docs/production-runbook.md)                   | operations                         |
| [Slack agent](docs/SLACK_AGENT.md) · [AI governance](docs/AI_GOVERNANCE.md)                                                                | the Foundry agent                  |
| [Creator onboarding](docs/CREATOR_ONBOARDING.md)                                                                                           | the activation workflow            |
