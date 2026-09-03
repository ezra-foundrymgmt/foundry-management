# Inngest setup

Inngest runs CreatorOS's durable background work. Status: the client, the serve
endpoint and four functions exist and are registered.

## Endpoint

```
https://<your-domain>/api/inngest
```

Served with the official App Router integration (`inngest/next`), exporting
GET, POST and PUT. It is excluded from the auth proxy because Inngest
authenticates with a signing key, not a session cookie.

## Registered functions

| Function id                     | Trigger events                                              | Retries |
| ------------------------------- | ----------------------------------------------------------- | ------- |
| `creator-activation-v1`         | `creator.activation.requested`, `creator.activation.resume` | 4       |
| `creator-daily-report-generate` | `creator.daily-report.requested`                            | 3       |
| `creator-report-scheduler`      | cron `0 * * * *` (hourly)                                   | 2       |
| `foundry-agent-slack-respond`   | `slack.agent.requested`                                     | 2       |

`creator-report-scheduler` has no trigger event because nothing requests it —
it is the one process that decides a report is due, reading each creator's
report schedule against their own timezone and firing
`creator.daily-report.requested` for the ones due this hour.
`concurrency: { limit: 1 }` keeps only one pass running across the whole
deployment, so a slow pass and its next hourly firing cannot double up.

## Environment variables

| Variable                       | From                               |
| ------------------------------ | ---------------------------------- |
| `INNGEST_EVENT_KEY`            | Inngest → Manage → Event Keys      |
| `INNGEST_SIGNING_KEY`          | Inngest → Manage → Signing Key     |
| `INNGEST_SIGNING_KEY_FALLBACK` | optional, used during key rotation |

Both are required in live mode; `validate-env.mjs` fails the build without them.

## Register the app

1. Deploy first — Inngest must be able to reach the endpoint.
2. Inngest dashboard → **Apps → Sync new app** → paste
   `https://<your-domain>/api/inngest`.
3. Confirm all four functions appear.

Re-sync after any deploy that adds or renames a function.

## How durability actually works here

Worth understanding before trusting it, because the guarantee is narrower than
"Inngest makes it durable".

Activation runs **one `step.run` per activation step**, so Inngest checkpoints
each one. An interrupted deploy resumes at the step boundary it reached rather
than replaying all 26.

Resume across invocations does not rely on Inngest's memoisation at all — it
relies on the run being persisted in `workflow_runs` and `workflow_steps` after
every step. `advance()` re-reads that state and skips steps already marked
SUCCEEDED. That is why an activation survives a redeploy that discards Inngest's
in-flight state.

Failures throw from **inside** `step.run`. This matters: returning a failed
result and throwing afterwards would let Inngest memoise the failure and replay
it on every retry without re-executing anything, which is exactly the bug this
code previously had.

Concurrency is fenced in Postgres, not in the process. The in-process creator
lock is a no-op in the Supabase repository; `workflow_runs_one_active_creator_definition_uidx`
permits only one non-terminal run per creator, so a race surfaces as a unique
violation and a retry rather than two parallel activations.

## Idempotency keys

| Path              | Key                                                     |
| ----------------- | ------------------------------------------------------- |
| Start activation  | `creator:<creatorId>:activation:v1`                     |
| Resume activation | `creator:<creatorId>:activation:resume:<correlationId>` |
| Agent reply       | the Slack `event_id`                                    |

The resume key deliberately differs from the start key. Reusing it would make
Inngest deduplicate a resume against the original request and silently drop it,
so a run could never be resumed twice.

## Verify

1. `GET /api/inngest` returns the introspection payload.
2. All four functions listed in the dashboard.
3. `POST /api/onboarding` with a real creator id returns `202 QUEUED` with an
   event id, and a run appears in Inngest.
4. Interrupt or redeploy mid-run, then `POST /api/workflows/resume`; the run
   continues from where it stopped rather than restarting.
5. Inspect `workflow_steps` — attempts increment on retry, external ids persist.

## Failure modes

| Symptom                             | Cause                                                           |
| ----------------------------------- | --------------------------------------------------------------- |
| Functions not listed                | App never synced, or the deploy is unreachable                  |
| `401` from Inngest                  | Signing key mismatch between dashboard and environment          |
| Runs queue but never execute        | Endpoint unreachable, or blocked by the auth proxy              |
| `SLACK_INTEGRATION_NOT_CONNECTED`   | Activation reached provisioning before Slack was connected      |
| `NOTION_PARENT_PAGE_NOT_CONFIGURED` | Creator Hub root not set (see NOTION_SETUP.md)                  |
| A resume appears to do nothing      | Duplicate idempotency key — check the event id in the dashboard |
