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

### The migration chain replays on Postgres, but not yet on Supabase — PARTIAL

There are twelve migrations. The domain test suite replays all of them in order,
plus the seed, against a real PostgreSQL engine (pglite, Postgres compiled to
WASM) on every test run, and asserts RLS and grant behaviour against it. That is
machine verification, not inspection — it is what caught the ON CONFLICT defect
that would have stopped every activation, and it reproduces the exact error.

What it does not cover is a real Supabase project: GoTrue's `auth` schema, the
`anon`/`authenticated`/`service_role` roles as Supabase actually defines them,
`pgcrypto` (the suite skips that extension because pglite omits the control
file), PostgREST's own SQL generation, and an existing database with data in it.
**Replay against a staging Supabase project is still required** and is the first
blocking item in `docs/HUMAN_ACTIONS.md`.

One replay-blocking defect was found and fixed by inspection: `seed.sql`
collided with migration 0005 on three tables and aborted every `db:reset`. All
seven seed inserts are now idempotent. That fix is itself unverified against a real
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
gate are MACHINE VERIFIED by the agent test suite. The end-to-end path — a real `@Foundry`
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

### Several pages still render fictional seed data — PARTIAL

`/creators`, `/crm/prospects`, `/audit` and `/workflows` read from Supabase.
Still on fixtures from `packages/domain/src/seed.ts`: the command centre,
creator detail, tasks, reports, experiments, content, economics, incidents and
applications. Madison Carter, Ava Monroe, Sarah Vale and their numbers are
fictional and identical in every environment on those pages.

`/creators/[creatorId]` is the most misleading of the remaining ones: the Brand
Dossier, operating state and data-quality panels are hardcoded rather than read
from `creator_brand_profiles`, `creator_truth_items` and `creator_boundaries`.

### CRM prospects are writable — MACHINE VERIFIED

Create, stage change, owner, follow-up, activity log, note and archive all
persist through `/api/prospects*`. Search and a follow-up-due filter work.
Duplicate prevention matches on email, else on a normalised name, and names the
existing prospect number. Archive is a soft delete. 14 tests cover it.

Still missing on the CRM: a create form in the UI (the API exists and is tested,
but nothing on the page calls it), owner reassignment UI, and the equivalent
write surface for `/crm/applications`.

### Daily reports are produced from real data — MACHINE VERIFIED

`produceDailyCreatorReport` reads the creator's own frozen baseline, sums the
trailing window from `creator_revenue_daily` and `social_posts`, runs the rules
engine, and upserts into `daily_creator_reports`.

It refuses when the creator is not in the organization, when no baseline has
been frozen, or when no metrics exist — writing nothing and reporting the reason
rather than producing a report whose comparisons would be invented.

### Report schedules now execute — MACHINE VERIFIED

`creator-report-scheduler` runs hourly, claims whichever schedules are due, and
records the outcome. Claiming and advancing `next_due_at` happen in one SQL
statement, so two overlapping runs cannot both take the same schedule. The
advance steps forward from the schedule's own due time in whole cadence
intervals, so a late run does not walk a 09:00 report later each day and an
outage produces one catch-up report rather than a burst. Report dates are
resolved in the schedule's timezone. A failure backs off to a bounded retry; a
creator with no frozen baseline is recorded SKIPPED and waits for the next
cadence rather than producing an invented report.

Never executed against a real Postgres or a real Inngest deployment.

### Slack identity mapping is administered in the app — MACHINE VERIFIED

Settings → Integrations → Slack identities lists every active member with their
link and allows a `user.manage` holder to link or unlink. Slack confirms the
account exists in this workspace before the link is written, so a typo cannot
create a live grant addressed to an id Slack could later assign to someone else;
deactivated accounts, bots, accounts from another workspace and users outside the
organization are all refused. Unlinking deactivates rather than deletes. Both
directions append to the audit trail.

Never exercised against a real Slack workspace: linking calls `users.info`.

### The ACTIVE invariant is enforced — MACHINE VERIFIED

`evaluateActivationReadiness` answers READY / WAITING / BLOCKED / INCOMPLETE from
the records themselves — never workflow status, never a completion percentage —
and `completeActivation` refuses to write ACTIVE unless the answer is READY.
BLOCKED outranks INCOMPLETE outranks WAITING, so the reported reason is the one
someone can act on. A count that cannot be read throws rather than reading as
zero. The creator page shows the evaluation next to the status.

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

| Area                        | Status                    | Detail                                                                                                                                                                                                                                                                                             |
| --------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Notion duplicate page       | PARTIAL                   | Store lookup plus title reconcile. Notion's search index is eventually consistent, so a crash-and-retry inside the indexing window can still create a second hub page. Notion offers no create-if-absent, so this cannot be fully closed client-side.                                              |
| `database.types.ts`         | PARTIAL                   | A 26-line stub, not generated types. Supabase queries are effectively untyped; a column rename would compile fine and fail at runtime.                                                                                                                                                             |
| Observability               | PARTIAL                   | Structured logging plus `captureException`, which reports to Sentry when `SENTRY_DSN` is set and is a no-op otherwise. Never verified against Sentry — the payload shape is correct by documentation only. There is still no alerting and no aggregation, and client-side errors are not captured. |
| Rate limiting               | PARTIAL                   | A DB-backed `consume_api_rate_limit` function exists and is used on write routes. Reads and the Slack ingress are unlimited.                                                                                                                                                                       |
| Audit coverage              | PARTIAL                   | Integration connects and some mutations append audit events. Not every write is audited.                                                                                                                                                                                                           |
| `audit_events` immutability | MACHINE VERIFIED (static) | UPDATE and DELETE blocked by trigger; TRUNCATE blocked by a statement trigger added in migration 0006. Never executed.                                                                                                                                                                             |
| e2e coverage                | PARTIAL                   | Six Playwright tests, all in mock mode as an unauthenticated super_admin. Nothing exercises real auth, multi-user, or live data. CI does not run them and does not install browsers.                                                                                                               |
| Multi-user                  | MISSING                   | Ezra and Payton have no accounts yet. Concurrent-editing behaviour is untested.                                                                                                                                                                                                                    |
| Offboarding                 | PARTIAL                   | `OFFBOARDING_STEPS` is a nine-step list with no executor.                                                                                                                                                                                                                                          |
| Google Workspace            | MISSING                   | Deliberately out of scope. `ManualFileStorageProvider` returns a placeholder.                                                                                                                                                                                                                      |
| OnlyFans                    | MISSING by design         | `OnlyFansProviderPlaceholder` returns `NOT_CONFIGURED` and performs no scraping or unofficial automation. Correct and intentional.                                                                                                                                                                 |
| Backups                     | MISSING                   | No backup or restore procedure has been tested. Supabase's own backups are whatever the project's plan provides.                                                                                                                                                                                   |

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

### Adversarial security re-review — findings closed

A 13-agent adversarial audit ran over seven dimensions after the live wiring:
live/mock fallback, credentials and RLS, route authorization, Slack ingress and
identity, agent tool permissions, Notion projection, and workflow/scheduler.
Nineteen candidates, six adversarially verified, five confirmed. All are fixed
and covered by tests; three were proved by reintroducing the defect and watching
the test fail.

Two of the confirmed findings meant CreatorOS could not have worked at all: every
role check was bypassable through PostgREST with a browser access token, and no
creator could ever have reached ACTIVE because three activation upserts named a
conflict target PostgreSQL cannot infer.

One finding was **refuted** and is recorded as refuted rather than fixed: the env
templates omit `PRODUCTION_SUPABASE_PROJECT_REF`, but four operator documents
instruct setting it in every environment, and the guard is enforced again at
runtime when the service-role client is constructed.

The audit reasoned about code, not a running system. It cannot substitute for the
live gates in `docs/HUMAN_ACTIONS.md` — a real Slack signature, a real revoked
token, a real cross-tenant request.

### No weekly review producer — MISSING

`SCHEDULE_WEEKLY_REVIEW` creates a WEEKLY schedule row and `weekly_creator_reports`
exists, but nothing generates one. The scheduler records
`WEEKLY_REVIEW_NOT_IMPLEMENTED` against the schedule rather than regenerating that
day's daily report, which is what it silently did before.
