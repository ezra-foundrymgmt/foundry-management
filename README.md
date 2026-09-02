# CreatorOS

CreatorOS is Foundry Management's internal operating system for creator acquisition, onboarding, operations, content intelligence, performance reporting, unit economics, and integration health. It is designed around one canonical record, tenant isolation, least privilege, explainable rules, and deterministic workflows.

The repository is a strict TypeScript monorepo:

- `apps/web` — Next.js App Router application and server endpoints.
- `packages/domain` — scores, diagnostics, permission rules, and fictional demo data.
- `packages/workflows` — resumable `CREATOR_ACTIVATION_V1` orchestration.
- `packages/integrations` — typed Slack, Notion, file, revenue, and intelligence providers.
- `supabase` — Postgres migrations, RLS, Auth configuration, and deterministic seed data.
- `docs` — architecture, security, domain, workflow, and integration decisions.

## Local setup

Prerequisites are Node.js 22 or newer, Corepack/pnpm, and Docker only when running local Supabase.

```bash
corepack enable
pnpm install
copy .env.example .env.local
pnpm dev
```

Open `http://localhost:3000`. Mock integration mode is the default; Slack, Notion, Google, OpenAI, Anthropic, and creator-revenue credentials are not required.

## Commands

```bash
pnpm dev            # web development server
pnpm build          # production build
pnpm lint           # lint all workspaces
pnpm typecheck      # strict TypeScript checks
pnpm test           # unit, integration, security/schema tests
pnpm test:e2e       # Playwright browser flows
pnpm db:start       # start local Supabase
pnpm db:reset       # replay migrations and seed
pnpm db:migrate     # apply pending local migrations
pnpm seed           # reset and seed demo state
```

## Authentication and data

Production mode uses Supabase Auth and Postgres RLS. The local UI uses an explicit fictional `super_admin` session in `CREATOROS_INTEGRATION_MODE=mock`; it never claims mock data or resources are live. Business tables carry `organization_id`, and database policies check active organization membership.

## Deployment

Deploy `apps/web` to Vercel or an equivalent Next.js host. Create a Supabase project, apply `supabase/migrations`, configure the environment keys from `.env.example`, and connect Inngest when durable hosted jobs are enabled. Leave optional providers unset until approved credentials exist; the rules and mock providers keep the product functional.

See [Architecture](docs/ARCHITECTURE.md), [Database](docs/DATABASE.md), [Security](docs/SECURITY.md), and [Creator onboarding](docs/CREATOR_ONBOARDING.md).
