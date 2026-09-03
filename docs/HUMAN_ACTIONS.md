# Human actions required

Everything here needs a person with credentials. None of it can be done from the
codebase, and no amount of further engineering removes any of it.

**No secret values appear in this file. None should be pasted into a chat.**

Every action below states its provider, where in that provider's dashboard it
lives, the exact setting or environment variable, the kind of value it takes, how
to prove it worked, and whether internal launch is blocked without it.

---

## Blocking summary

Internal launch means Ezra and Payton running Foundry through CreatorOS on a
hosted deployment. These block it:

| #    | Action                             | Provider  | Blocks launch                                     |
| ---- | ---------------------------------- | --------- | ------------------------------------------------- |
| 1.1  | Staging project                    | Supabase  | **Yes** — migrations are unreplayed               |
| 1.3  | Migration replay                   | Supabase  | **Yes**                                           |
| 1.4  | `verify-live.mjs` tenant proof     | Supabase  | **Yes** — isolation is unproven until this passes |
| 1.5  | Production migration push          | Supabase  | **Yes**                                           |
| 1.6  | Auth redirect URLs                 | Supabase  | **Yes** — sign-in fails without them              |
| 2, 3 | Ezra and Payton accounts           | Supabase  | **Yes**                                           |
| 4    | Inngest keys and app sync          | Inngest   | **Yes** — no activation or report runs            |
| 5    | Slack app, scopes, events, connect | Slack     | **Yes** for the agent; no for the app             |
| 6    | Notion integration and hub root    | Notion    | **Yes** — activation refuses without it           |
| 7    | Anthropic key                      | Anthropic | **Yes** for the agent; no for the app             |
| 8    | Vercel env vars and deploy         | Vercel    | **Yes**                                           |
| 9    | Custom domain                      | Vercel    | No — `*.vercel.app` works for everything          |
| 10   | PWA install                        | —         | No — the browser works                            |

Ordering matters and is given at the end. Deploy has to precede the Inngest sync
and the Slack Request URL, because both need a reachable HTTPS endpoint.

---

## 1. Supabase

There are **12 migrations** in `supabase/migrations`. The test suite replays all
of them against a real PostgreSQL engine on every run, so the chain itself is
proven. What is not proven is the chain against _Supabase_ — its `auth` schema,
its role definitions, `pgcrypto`, PostgREST, and a database that already has data
in it. That is what the steps below establish.

### 1.1 Create a staging project — BLOCKING

|                |                                                     |
| -------------- | --------------------------------------------------- |
| **Dashboard**  | <https://supabase.com/dashboard> → New project      |
| **Setting**    | Project name `creatoros-staging`                    |
| **Value type** | Name and a database password you keep               |
| **Verify**     | The project reaches ACTIVE_HEALTHY in the dashboard |

The first replay must not be against Foundry Management's real data.

### 1.2 Collect keys — BLOCKING

|                |                                               |
| -------------- | --------------------------------------------- |
| **Dashboard**  | Project Settings → API, for **both** projects |
| **Setting**    | See the table below                           |
| **Value type** | URL and opaque key strings                    |
| **Verify**     | Used in 1.3 and 1.4; a wrong key fails there  |

| Environment variable                   | Field in the dashboard                | Type                              |
| -------------------------------------- | ------------------------------------- | --------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`             | Project URL                           | `https://` URL                    |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Publishable key (or legacy `anon`)    | Non-empty string, browser-safe    |
| `SUPABASE_SECRET_KEY`                  | Secret key (or legacy `service_role`) | Non-empty string, **server only** |

`SUPABASE_SERVICE_ROLE_KEY` is accepted as a fallback for the legacy name. The
secret key bypasses RLS. It must never be set on a `NEXT_PUBLIC_` variable and
never pasted anywhere it could be logged.

### 1.3 Replay the migrations against staging — BLOCKING

|                |                                              |
| -------------- | -------------------------------------------- |
| **Dashboard**  | CLI, linked to the staging project ref       |
| **Setting**    | `supabase db push`, then `supabase db reset` |
| **Value type** | Staging project ref (from the project URL)   |
| **Verify**     | Both commands exit 0                         |

```bash
npx supabase login
npx supabase link --project-ref <staging-ref>
npx supabase db push
npx supabase db reset      # destructive: staging only
```

If `db reset` fails, that is a real finding, not a setup problem: the chain has
never been executed end to end.

### 1.4 Run the adversarial tenant check — BLOCKING

|                |                                                |
| -------------- | ---------------------------------------------- |
| **Dashboard**  | CLI, against staging                           |
| **Setting**    | `apps/web/scripts/verify-live.mjs`             |
| **Value type** | The three staging values from 1.2, as env vars |
| **Verify**     | Prints `{"status":"LIVE_VERIFIED",...}`        |

```bash
NEXT_PUBLIC_SUPABASE_URL=... \
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... \
SUPABASE_SECRET_KEY=... \
node apps/web/scripts/verify-live.mjs
```

This is the single most important outstanding verification. Until it passes,
tenant isolation is unproven. Do not weaken the script to get a green result: a
failure here is the finding.

### 1.5 Apply to production — BLOCKING

|                |                                                                                 |
| -------------- | ------------------------------------------------------------------------------- |
| **Dashboard**  | CLI, linked to project ref `mqyvckazqawrqqsasomj`                               |
| **Setting**    | `supabase db push` only                                                         |
| **Value type** | Production project ref                                                          |
| **Verify**     | Exits 0; `select count(*) from public.creators` still returns the expected rows |

Never `db reset` and never `seed.sql` against production. Both destroy data.

### 1.6 Auth URLs — BLOCKING

|                |                                                                       |
| -------------- | --------------------------------------------------------------------- |
| **Dashboard**  | Authentication → URL Configuration, both projects                     |
| **Setting**    | Site URL, Redirect URLs                                               |
| **Value type** | `https://<your-domain>` and `https://<your-domain>/auth/callback`     |
| **Verify**     | Sign-in completes and lands back on the app rather than an error page |

---

## 2. Ezra's account — BLOCKING

|                |                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| **Provider**   | Supabase                                                                                              |
| **Dashboard**  | Authentication → Users → Add user, then SQL editor                                                    |
| **Setting**    | `public.users` row and one active `public.organization_memberships` row                               |
| **Value type** | Real email, the auth user id Supabase generates, role `super_admin`                                   |
| **Verify**     | Sign in, then confirm Settings loads and a change you make appears in the audit log attributed to you |

```sql
insert into public.users (id, email, display_name)
values ('<auth_user_id>', '<your email>', 'Ezra')
on conflict (id) do update set email = excluded.email;

insert into public.organization_memberships (organization_id, user_id, role, active)
values ('00000000-0000-4000-8000-000000000001', '<auth_user_id>', 'super_admin', true)
on conflict (organization_id, user_id) do update set role = excluded.role, active = true;
```

## 3. Payton's account — BLOCKING

Identical, with Payton's own email and auth user id and `display_name` `'Payton'`.

**Do not share a login.** Every write is attributed to the signed-in user; a
shared account makes the audit trail meaningless.

Exactly one active membership per user. Two active memberships resolve to no
session at all.

---

## 4. Inngest — BLOCKING

Without this nothing durable runs: no activation, no scheduled reports, no agent
replies.

|                |                                                      |
| -------------- | ---------------------------------------------------- |
| **Dashboard**  | <https://app.inngest.com> → your app → Manage → Keys |
| **Setting**    | `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`           |
| **Value type** | Opaque key strings                                   |
| **Verify**     | See the sync check below                             |

`INNGEST_SIGNING_KEY_FALLBACK` is optional and only used during a key rotation.

**After deploying:** Apps → Sync new app → `https://<your-domain>/api/inngest`.

**Verify** — exactly these four functions must appear:

| Function id                     | What it does                                         |
| ------------------------------- | ---------------------------------------------------- |
| `creator-activation-v1`         | Runs the 26-step activation, one step per checkpoint |
| `creator-daily-report-generate` | Produces one creator's report on request             |
| `creator-report-scheduler`      | Hourly cron; runs whichever schedules are due        |
| `foundry-agent-slack-respond`   | Answers a Slack mention or DM                        |

If `creator-report-scheduler` is missing, scheduled reports silently never run.
There is deliberately no second scheduler — do not add a Vercel cron.

---

## 5. Slack

Blocking for the Foundry agent and for creator/internal channel provisioning.
The rest of CreatorOS works without it.

### 5.1 Credentials

|                |                                                                    |
| -------------- | ------------------------------------------------------------------ |
| **Dashboard**  | Slack app → Basic Information → App Credentials                    |
| **Setting**    | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`   |
| **Value type** | Client id `1234...`, and two opaque secrets                        |
| **Verify**     | 5.5 completes; a forged request to `/api/slack/events` returns 401 |

### 5.2 Redirect URL

|                |                                                           |
| -------------- | --------------------------------------------------------- |
| **Dashboard**  | OAuth & Permissions → Redirect URLs                       |
| **Setting**    | `SLACK_REDIRECT_URI` and the Slack-side entry             |
| **Value type** | `https://<your-domain>/api/integrations/slack/callback`   |
| **Verify**     | Connect completes instead of returning `bad_redirect_uri` |

The two must byte-match, trailing slash included.

### 5.3 Bot scopes

|                |                                                                                                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dashboard**  | OAuth & Permissions → Bot Token Scopes                                                                                                                                     |
| **Setting**    | `channels:manage`, `channels:read`, `groups:write`, `groups:read`, `chat:write`, `users:read`; for the agent also `app_mentions:read`, `im:history`, `im:read`, `im:write` |
| **Value type** | Scope list                                                                                                                                                                 |
| **Verify**     | Activation provisions both channels; the agent answers a DM                                                                                                                |

`users:read` is what lets identity linking confirm a Slack account exists.

### 5.4 Event Subscriptions

|                |                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------- |
| **Dashboard**  | Event Subscriptions → Enable Events                                                             |
| **Setting**    | Request URL `https://<your-domain>/api/slack/events`; bot events `app_mention` and `message.im` |
| **Value type** | HTTPS URL                                                                                       |
| **Verify**     | Slack shows **Verified** next to the Request URL                                                |

The signing secret must already be set in the deployed environment or the URL
will not verify.

### 5.5 Connect

|                |                                                       |
| -------------- | ----------------------------------------------------- |
| **Dashboard**  | CreatorOS → Settings → Integrations → Slack → Connect |
| **Setting**    | OAuth install                                         |
| **Value type** | —                                                     |
| **Verify**     | The card shows CONNECTED and names the workspace      |

### 5.6 Link Slack identities — BLOCKING for the agent

Being in the Slack workspace is not authorization. Until a Slack account is
linked, the agent denies that person entirely.

|                |                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Dashboard**  | CreatorOS → Settings → Integrations → **Slack identities**                                                         |
| **Setting**    | Slack member ID per CreatorOS user                                                                                 |
| **Value type** | `U…` or `W…` — Slack profile → **Copy member ID**                                                                  |
| **Verify**     | The row shows CONNECTED with the Slack display name; the person gets an answer from `@Foundry` instead of a denial |

Requires the `user.manage` permission, so `super_admin`. Slack is asked to
confirm the account before the link is saved, so a wrong ID is refused rather
than stored. Deleted accounts and bots are refused. No SQL is needed any more.

### 5.7 Optional least-privilege cleanup — not blocking

The existing app holds broader scopes than CreatorOS uses: `assistant:write` and
the user-token search scopes are unused. Removing them requires a reinstall,
which rotates the bot token; reconnect afterwards. See `docs/SLACK_SETUP.md`.

---

## 6. Notion — BLOCKING

Activation refuses to run without a configured Creator Hub root.

| Step | Dashboard                                    | Setting                                                                                                                    | Value type                                                                                | Verify                                                     |
| ---- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 6.1  | <https://www.notion.so/my-integrations>      | Create an internal integration (simplest), or OAuth with redirect `https://<your-domain>/api/integrations/notion/callback` | Integration token, or `NOTION_CLIENT_ID` / `NOTION_CLIENT_SECRET` / `NOTION_REDIRECT_URI` | 6.4 connects                                               |
| 6.2  | Notion                                       | Create the page that will hold creator hubs, e.g. `Foundry / Creators`                                                     | A normal Notion page                                                                      | It exists                                                  |
| 6.3  | That page → ••• → Connections                | **Share the page with the integration**                                                                                    | —                                                                                         | 6.5 succeeds instead of `NOTION_PAGE_NOT_SHARED`           |
| 6.4  | CreatorOS → Settings → Integrations → Notion | Connect                                                                                                                    | —                                                                                         | Card shows CONNECTED                                       |
| 6.5  | Same card → **Creator Hub root**             | Page ID                                                                                                                    | 32 hex characters, from the page URL                                                      | The card names the page by title instead of NOT CONFIGURED |

Step 6.3 is the one people miss. A Notion integration sees nothing until a page
is explicitly shared with it, and Notion answers 404 for a page that is not
shared exactly as it does for one that does not exist. CreatorOS fetches the page
before saving it, so an unshared or archived page is refused with a message
naming the problem rather than accepted and failing later during an activation.

Until the root is set, activation fails with `NOTION_PARENT_PAGE_NOT_CONFIGURED`.

---

## 7. Anthropic — BLOCKING for the agent

|                |                                                            |
| -------------- | ---------------------------------------------------------- |
| **Dashboard**  | <https://console.anthropic.com> → API keys                 |
| **Setting**    | `ANTHROPIC_API_KEY`                                        |
| **Value type** | `sk-ant-…`                                                 |
| **Verify**     | `@Foundry` in Slack produces an answer rather than silence |

Without it the Slack ingress still verifies signatures and dedupes events, but no
reply is produced. `FOUNDRY_AGENT_MODEL` is optional and defaults to
`claude-opus-5`.

---

## 8. Vercel — BLOCKING

### 8.1 Root Directory

|                |                                               |
| -------------- | --------------------------------------------- |
| **Dashboard**  | Project → Settings → General → Root Directory |
| **Setting**    | The repository root — leave it empty          |
| **Value type** | Path                                          |
| **Verify**     | The build finds `vercel.json` and succeeds    |

There is one `vercel.json`, at the root. Setting Root Directory to `apps/web`
breaks the build.

### 8.2 Environment variables

|               |                                                               |
| ------------- | ------------------------------------------------------------- |
| **Dashboard** | Project → Settings → Environment Variables                    |
| **Setting**   | The table below, Production and Preview set separately        |
| **Verify**    | Deploy succeeds; the app renders live data with no demo strip |

| Variable                                    | Production             | Preview             | Type                                             |
| ------------------------------------------- | ---------------------- | ------------------- | ------------------------------------------------ |
| `APP_ENV`                                   | `production`           | `staging`           | enum: `development` \| `staging` \| `production` |
| `CREATOROS_INTEGRATION_MODE`                | `live`                 | `live`              | enum: `mock` \| `live`                           |
| `NEXT_PUBLIC_APP_URL`                       | production URL         | preview URL         | `https://` URL                                   |
| `NEXT_PUBLIC_SUPABASE_URL`                  | production project     | **staging project** | `https://` URL                                   |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`      | production             | staging             | string                                           |
| `SUPABASE_SECRET_KEY`                       | production             | staging             | string, server only                              |
| `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` | ✓                      | ✓                   | string                                           |
| `INTEGRATION_ENCRYPTION_KEY`                | ✓                      | ✓ (different value) | 32 random bytes, base64                          |
| `PRODUCTION_SUPABASE_PROJECT_REF`           | `mqyvckazqawrqqsasomj` | same value          | project ref                                      |
| Slack / Notion / Anthropic keys             | ✓                      | optional            | string                                           |

`CREATOROS_INTEGRATION_MODE=live` is not optional. Mock mode fails the build in
any deployed environment, because mock mode serves an unauthenticated
`super_admin` console.

`PRODUCTION_SUPABASE_PROJECT_REF` must be set on **Preview** too. That is what
makes a preview deployment refuse to start when it is pointed at the production
database — the check compares the two and fails closed.

Generate the encryption key:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Rotating it makes every stored OAuth token undecryptable; reconnect Slack and
Notion afterwards.

### 8.3 Deploy

```bash
npx vercel login
npx vercel --prod
```

**Verify:** the deployed URL loads, sign-in works, and `/settings/integrations`
shows "Live infrastructure" rather than "Safe preview".

---

## 9. Domain and DNS — not blocking

|                |                                                        |
| -------------- | ------------------------------------------------------ |
| **Dashboard**  | Vercel → Settings → Domains                            |
| **Setting**    | Add the domain, then create the CNAME Vercel shows     |
| **Value type** | Domain name, DNS record                                |
| **Verify**     | HTTPS certificate issues and the domain serves the app |

If you use a custom domain, `NEXT_PUBLIC_APP_URL`, `SLACK_REDIRECT_URI`,
`NOTION_REDIRECT_URI`, the Slack Request URL, and the Supabase redirect URLs must
all be updated to match. Without a custom domain the `*.vercel.app` URL works for
everything.

---

## 10. Install the PWA — not blocking

|                |                                                         |
| -------------- | ------------------------------------------------------- |
| **Dashboard**  | The deployed HTTPS URL, in each person's browser        |
| **Setting**    | Install / Add to Home Screen                            |
| **Value type** | —                                                       |
| **Verify**     | The app opens in its own window with the CreatorOS icon |

Ezra and Payton each, on their own machine. See `docs/PWA_INSTALL.md`.

---

## Order of operations

```
Supabase staging → migrations → verify-live.mjs → accounts (Ezra, Payton)
  → Vercel env vars → deploy
      → Inngest sync
      → Slack connect → Event Subscriptions → identity linking
      → Notion connect → share page → Creator Hub root
      → PWA install
```

Deploy has to come before the Inngest sync and the Slack Request URL, because
both need a reachable HTTPS endpoint.
