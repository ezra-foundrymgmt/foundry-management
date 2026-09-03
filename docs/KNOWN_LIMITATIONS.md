# Known limitations

Written to be believed. Everything here is a real gap in CreatorOS as it stands,
stated without spin. Status classes:

- **LIVE VERIFIED** — exercised against the real external system
- **MACHINE VERIFIED** — real implementation, exercised by a real test
- **FIXTURE VERIFIED** — exercised only through mocks
- **CREDENTIAL BLOCKED** — implementation complete, cannot run without human credentials
- **PARTIAL** — meaningful portion exists, required behaviour incomplete
- **MISSING** — does not exist

## Nothing in CreatorOS is LIVE VERIFIED

No part of this system has been exercised against live Supabase, Inngest, Slack,
Notion, Vercel, or the Anthropic API. The Supabase CLI and Vercel CLI on the
build machine are both unauthenticated, there is no `.env.local`, and no
deployment has been performed. Every claim below is MACHINE or FIXTURE verified
unless it says otherwise.

## The big ones

### The application is not deployed — CREDENTIAL BLOCKED

The Vercel project is linked but nothing has been deployed. CreatorOS is not
reachable from anywhere, so it still depends on localhost in practice. The
hosted PWA cannot be installed until a deployment exists.

### The migration chain has never been replayed — CREDENTIAL BLOCKED

There are seven migrations. They have been reviewed statically but never
executed in order against a real Postgres. No Docker and no `psql` are available
on the build machine, and per instruction nothing destructive was run against
the live Foundry project. **Fresh-replay success is unproven.**

One replay-blocking defect was found and fixed by inspection: `seed.sql`
collided with migration 0005 on three tables and aborted every `db:reset`. All
seven inserts are now idempotent. That fix is itself unverified against a real
database.

### RLS and tenant isolation are unproven against a real database — CREDENTIAL BLOCKED

The policies read correctly: `is_organization_member()` is `security definer`
with an empty `search_path` and resolves through `auth.uid()`, applied to 50
tables, with browser roles reduced to `select` only. `apps/web/scripts/verify-live.mjs`
is a real adversarial script that creates two organizations and asserts cross-tenant
reads and writes fail. **It has never been run.** Run it first once credentials exist.

Agent-level tenant isolation _is_ MACHINE VERIFIED: 11 tests assert every agent
tool query carries an `organization_id` filter equal to the caller's session org.

### The Foundry agent has never spoken to Slack or Claude — CREDENTIAL BLOCKED

Signature verification, event dedupe, the tool registry and the authorization
gate are MACHINE VERIFIED by 37 tests. The end-to-end path — a real `@Foundry`
mention producing a real reply — has never run.

### Activation steps now do real work — MACHINE VERIFIED

Previously 21 of the 26 steps returned `null` and were marked SUCCEEDED without
touching anything, so a completed activation did not imply a brand profile, a
P&L period, internal tasks or a report schedule existed.

All 26 now act. 5 provision external resources (Slack, Notion, files), 18 write
CreatorOS records through `ActivationRecordPort`, 1 posts the welcome message
into the channel activation actually provisioned, and 2 —`LOCK_IDEMPOTENCY` and
`AWAIT_BASELINE_READINESS` — are legitimately control-flow only: the first is
satisfied by the database's one-active-run index, the second is the baseline
gate itself.

Every record method upserts against a natural key, so a resume or a retry
updates its own earlier row rather than creating a second one. Three tests cover
this: the exact ordered call sequence, the welcome message landing in the
provisioned channel, and a resume not repeating completed bookkeeping.

**Still unproven against a real database.** The port is exercised through an
in-memory recorder; `SupabaseActivationRecordPort` has never run against
Postgres, so the `onConflict` targets are correct by inspection only.

Two deliberate choices worth knowing: `initializeHealth` writes `band: UNKNOWN`
with a zero score rather than inventing a health measurement, and
`requestRevenueIntegration` creates the row as `NOT_CONFIGURED` — it is a
request for a human to connect an account, never a claim that one is connected.

### Most pages still render fictional seed data — PARTIAL

Only `/creators`, `/crm/prospects` and `/audit` read from Supabase. The command
centre, creator detail, tasks, reports, experiments, content, economics,
incidents, workflows and applications pages render fixtures from
`packages/domain/src/seed.ts` — Madison Carter, Ava Monroe, Sarah Vale and their
numbers are fictional and identical in every environment.

`/workflows` in particular hardcodes progress rather than reading
`workflow_runs`, so it does not reflect real activation state.

### CRM is read-only — PARTIAL

There is no create, edit, stage change, owner assignment, follow-up, activity
log, note, or archive for prospects. The search inputs on `/creators` and
`/crm/prospects` and the "Filters" buttons render but do nothing. "Add prospect"
and "Add creator" are disabled. Prospect → creator conversion works.

### No daily report producer — MISSING

Nothing writes to `daily_creator_reports`. The Inngest report function reads
from the seed fixture, not the table. The reports page will stay empty against a
real database.

### Slack identity mapping is manual — PARTIAL

`slack_user_identities` has no UI. Linking Ezra and Payton is a hand-written SQL
insert (`docs/SLACK_SETUP.md` §6). An unmapped Slack user is refused, which is
correct but means the agent does nothing until the inserts are done.

### Findings from adversarial review that are NOT fixed

A 12-agent adversarial review executed the code against fake providers. The
critical and high findings were fixed and are covered by tests. These were
confirmed and deliberately left, with the reasoning:

| Finding                                                                                     | Why it is still open                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The agent permission gate is not backed by RLS                                              | A role denied a tool can still read the same tables directly with its own Supabase JWT, because browser roles hold `select` on business tables. The gate stops the _agent_ from retrieving it, not the database from serving it. Closing this means per-table role policies, which is a schema-wide change. |
| Prompt injection through database content is requested in the prompt, not enforced          | The system prompt tells the model that tool results are data, not instructions. Nothing in code enforces it. A creator who writes instructions into a field the agent reads could influence its output. It cannot escalate permissions — the gate is outside the model — but it can shape an answer.        |
| The creator-facing surface is not bound to a _specific_ creator                             | A creator channel is correctly identified as creator-facing, but the tool gate does not additionally check that the creator being asked about is the creator whose channel it is. An operator in creator A's channel can ask about creator B and get an answer.                                             |
| `INNGEST_DEV` disables signature verification on `/api/inngest`                             | It is outside the environment contract, so a deploy that sets it turns off verification on a proxy-exempt route with nothing to catch it.                                                                                                                                                                   |
| `/api/health` is unauthenticated and discloses environment and which secrets are configured | Useful for uptime checks, but it tells an anonymous caller more than it needs to.                                                                                                                                                                                                                           |
| No rate limit or concurrency cap on the agent                                               | An authorised Slack user can trigger unbounded model spend. Activation now has a concurrency cap; the agent does not.                                                                                                                                                                                       |
| Prerequisite and compliance blockers are evaluated only at run creation                     | Unlike the baseline gate, they are not re-checked on resume. A creator whose contract lapses mid-activation still completes.                                                                                                                                                                                |
| Raw Postgres error text reaches the model context                                           | A database error string is passed back as a tool result and can be relayed into Slack.                                                                                                                                                                                                                      |

## Smaller, specific gaps

| Area                        | Status                    | Detail                                                                                                                                                                                                                                                |
| --------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Notion duplicate page       | PARTIAL                   | Store lookup plus title reconcile. Notion's search index is eventually consistent, so a crash-and-retry inside the indexing window can still create a second hub page. Notion offers no create-if-absent, so this cannot be fully closed client-side. |
| `database.types.ts`         | PARTIAL                   | A 26-line stub, not generated types. Supabase queries are effectively untyped; a column rename would compile fine and fail at runtime.                                                                                                                |
| Observability               | PARTIAL                   | `logEvent` writes structured JSON to stdout with key-based redaction. There is no Sentry wiring, no alerting, and no error aggregation. `SENTRY_DSN` is accepted and unused.                                                                          |
| Rate limiting               | PARTIAL                   | A DB-backed `consume_api_rate_limit` function exists and is used on write routes. Reads and the Slack ingress are unlimited.                                                                                                                          |
| Audit coverage              | PARTIAL                   | Integration connects and some mutations append audit events. Not every write is audited.                                                                                                                                                              |
| `audit_events` immutability | MACHINE VERIFIED (static) | UPDATE and DELETE blocked by trigger; TRUNCATE blocked by a statement trigger added in migration 0006. Never executed.                                                                                                                                |
| e2e coverage                | PARTIAL                   | Six Playwright tests, all in mock mode as an unauthenticated super_admin. Nothing exercises real auth, multi-user, or live data. CI does not run them and does not install browsers.                                                                  |
| Multi-user                  | MISSING                   | Ezra and Payton have no accounts yet. Concurrent-editing behaviour is untested.                                                                                                                                                                       |
| Offboarding                 | PARTIAL                   | `OFFBOARDING_STEPS` is a nine-step list with no executor.                                                                                                                                                                                             |
| Google Workspace            | MISSING                   | Deliberately out of scope. `ManualFileStorageProvider` returns a placeholder.                                                                                                                                                                         |
| OnlyFans                    | MISSING by design         | `OnlyFansProviderPlaceholder` returns `NOT_CONFIGURED` and performs no scraping or unofficial automation. Correct and intentional.                                                                                                                    |
| Backups                     | MISSING                   | No backup or restore procedure has been tested. Supabase's own backups are whatever the project's plan provides.                                                                                                                                      |

## Things that are genuinely solid

Stated so the list above is not read as "nothing works":

- Postgres schema, RLS policy construction, and the uniqueness fences
  (one active run per creator, per-resource idempotency, single-use OAuth state).
- Token encryption at rest in a service-role-only table, never in `metadata_json`,
  never returned to the browser, never logged.
- Slack signature verification, replay window, and exactly-once event claiming.
- The agent authorization gate and its tenant scoping.
- The Notion creator-facing projection allowlist.
- Per-step durable activation with correct resume and idempotency semantics.
- Mock mode can no longer be deployed.
