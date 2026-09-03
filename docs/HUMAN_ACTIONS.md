# Human actions required

Everything here needs a person with credentials. None of it can be done from the
codebase. Ordered so each step unblocks the next.

No secret values appear in this file, and none should be pasted into a chat.

---

## 1. Supabase

**1.1 Create a staging project.** Nothing has ever been replayed against a real
Postgres, so the first replay must not be against Foundry Management.

- <https://supabase.com/dashboard> → New project → name it `creatoros-staging`.

**1.2 Collect keys** for both projects (Project Settings → API):

| Value                                  | Field in the dashboard                |
| -------------------------------------- | ------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`             | Project URL                           |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Publishable key (or legacy `anon`)    |
| `SUPABASE_SECRET_KEY`                  | Secret key (or legacy `service_role`) |

**1.3 Replay the migrations against staging** and confirm it actually succeeds:

```bash
npx supabase login
npx supabase link --project-ref <staging-ref>
npx supabase db push
npx supabase db reset      # destructive: staging only
```

If `db reset` fails, that is a real finding — the chain has never been executed
and its correctness is unproven.

**1.4 Run the adversarial tenant check.** This is the single most important
outstanding verification:

```bash
NEXT_PUBLIC_SUPABASE_URL=... \
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... \
SUPABASE_SECRET_KEY=... \
node apps/web/scripts/verify-live.mjs
```

Expect `{"status":"LIVE_VERIFIED",...}`. Until this passes, tenant isolation is
unproven.

**1.5 Apply to production** (`mqyvckazqawrqqsasomj`) with `db push` only —
never `db reset`, and never `seed.sql`.

**1.6 Auth URLs** (both projects) — Authentication → URL Configuration:

- Site URL: `https://<your-domain>`
- Redirect URLs: `https://<your-domain>/auth/callback`

---

## 2. Ezra's account

Authentication → Users → **Add user** with your real email, then in the SQL
editor (substituting your auth user id):

```sql
insert into public.users (id, email, display_name)
values ('<auth_user_id>', '<your email>', 'Ezra')
on conflict (id) do update set email = excluded.email;

insert into public.organization_memberships (organization_id, user_id, role, active)
values ('00000000-0000-4000-8000-000000000001', '<auth_user_id>', 'super_admin', true)
on conflict (organization_id, user_id) do update set role = excluded.role, active = true;
```

## 3. Payton's account

Identical, with Payton's own email and auth user id, and `display_name`
`'Payton'`. **Do not share a login** — every write is attributed to the
signed-in user, and a shared account makes the audit trail meaningless.

Exactly one active membership per user. Two active memberships resolve to no
session at all.

---

## 4. Inngest

1. <https://app.inngest.com> → create the CreatorOS app.
2. Copy the **Event Key** → `INNGEST_EVENT_KEY`.
3. Copy the **Signing Key** → `INNGEST_SIGNING_KEY`.
4. **After deploying**, Apps → Sync new app → `https://<your-domain>/api/inngest`.
5. Confirm three functions appear: `creator-activation-v1`,
   `creator-daily-report-generate`, `foundry-agent-slack-respond`.

---

## 5. Slack

**5.1 Credentials** — Slack app → Basic Information → App Credentials:
`SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`.

**5.2 Redirect URL** — OAuth & Permissions → Redirect URLs, exactly:

```
https://<your-domain>/api/integrations/slack/callback
```

Must byte-match `SLACK_REDIRECT_URI`.

**5.3 Bot scopes** — `channels:manage`, `channels:read`, `groups:write`,
`groups:read`, `chat:write`, `users:read`, plus for the agent
`app_mentions:read`, `im:history`, `im:read`, `im:write`.

**5.4 Event Subscriptions** — Request URL:

```
https://<your-domain>/api/slack/events
```

Subscribe to bot events `app_mention` and `message.im`. The signing secret must
already be set in the deployed environment or the URL will not verify.

**5.5 Connect** in CreatorOS → Settings → Integrations → Slack → Connect.

**5.6 Link Slack identities — mandatory, no UI exists.** Without this the agent
refuses everyone:

```sql
insert into public.slack_user_identities
  (organization_id, user_id, slack_team_id, slack_user_id)
values
  ('00000000-0000-4000-8000-000000000001', '<ezra creatoros user id>',   '<T...>', '<U...>'),
  ('00000000-0000-4000-8000-000000000001', '<payton creatoros user id>', '<T...>', '<U...>');
```

Slack member id: Slack profile → **Copy member ID**.

**5.7 Optional least-privilege cleanup.** The existing app holds broader scopes
than CreatorOS uses — `assistant:write` and the user-token search scopes are
unused. Removing them requires a reinstall, which rotates the bot token;
reconnect afterwards. Recommended, not urgent. See `docs/SLACK_SETUP.md`.

---

## 6. Notion

1. <https://www.notion.so/my-integrations> → create an internal integration
   (simplest), or configure OAuth with redirect
   `https://<your-domain>/api/integrations/notion/callback`.
2. Create the page that will hold creator hubs, e.g. `Foundry / Creators`.
3. **Share that page with the integration** — Notion integrations see nothing
   until a page is explicitly shared.
4. Connect in CreatorOS → Settings → Integrations → Notion.
5. Paste the page ID into **Creator Hub root**. Activation fails with
   `NOTION_PARENT_PAGE_NOT_CONFIGURED` until this is set.

---

## 7. Anthropic

Create a key at <https://console.anthropic.com> → `ANTHROPIC_API_KEY`.
Without it the Slack ingress still verifies and dedupes, but no reply is
produced. `FOUNDRY_AGENT_MODEL` defaults to `claude-opus-5`.

---

## 8. Vercel

**8.1 Root Directory: the repository root.** There is one `vercel.json`, at the
root. Setting Root Directory to `apps/web` breaks the build.

**8.2 Environment variables**, per environment (Production and Preview set
separately):

| Variable                                    | Production             | Preview             |
| ------------------------------------------- | ---------------------- | ------------------- |
| `APP_ENV`                                   | `production`           | `staging`           |
| `CREATOROS_INTEGRATION_MODE`                | `live`                 | `live`              |
| `NEXT_PUBLIC_APP_URL`                       | production URL         | preview URL         |
| `NEXT_PUBLIC_SUPABASE_URL`                  | production project     | **staging project** |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`      | production             | staging             |
| `SUPABASE_SECRET_KEY`                       | production             | staging             |
| `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` | ✓                      | ✓                   |
| `INTEGRATION_ENCRYPTION_KEY`                | ✓                      | ✓ (different value) |
| `PRODUCTION_SUPABASE_PROJECT_REF`           | `mqyvckazqawrqqsasomj` | same value          |
| Slack / Notion / Anthropic keys             | ✓                      | optional            |

`CREATOROS_INTEGRATION_MODE=live` is not optional. Mock mode fails the build in
any deployed environment because it would serve an unauthenticated super_admin
console.

Generate the encryption key:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

**8.3 Deploy:**

```bash
npx vercel login
npx vercel --prod
```

---

## 9. Domain and DNS

Optional. Vercel → Settings → Domains → add your domain, then create the CNAME
Vercel shows. If you use a custom domain, `NEXT_PUBLIC_APP_URL`,
`SLACK_REDIRECT_URI`, `NOTION_REDIRECT_URI`, the Slack Request URL, and the
Supabase redirect URLs must all be updated to match.

Without a custom domain the `*.vercel.app` URL works for everything.

---

## 10. Install the PWA

Ezra and Payton each, on their own machine, from the deployed HTTPS URL. See
`docs/PWA_INSTALL.md`.

---

## Order of operations

```
Supabase staging → migrations → verify-live.mjs → accounts (Ezra, Payton)
  → Vercel env vars → deploy
      → Inngest sync
      → Slack connect → Event Subscriptions → identity mapping
      → Notion connect → Creator Hub root
      → PWA install
```

Deploy has to come before Inngest sync and the Slack Request URL, because both
need a reachable HTTPS endpoint.
