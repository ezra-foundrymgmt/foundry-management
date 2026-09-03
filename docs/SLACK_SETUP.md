# Slack setup

CreatorOS uses Slack for two separate things. They are configured independently
and either can work without the other.

1. **Channel provisioning** — `CREATOR_ACTIVATION_V1` creates the creator and
   internal channels for each creator. Needs the OAuth install only.
2. **The Foundry agent** — `@Foundry` mentions and DMs. Needs the OAuth install
   *plus* Event Subscriptions *plus* `ANTHROPIC_API_KEY`.

Nothing in this document has been exercised against live Slack. The code paths
are complete; every step below is a human action that must be performed once.

## 1. Environment variables

Set these in Vercel (Production and Preview separately) and in `.env.local` for
local work. Never commit them.

| Variable | Where it comes from |
| --- | --- |
| `SLACK_CLIENT_ID` | Slack app → Basic Information → App Credentials |
| `SLACK_CLIENT_SECRET` | same panel |
| `SLACK_SIGNING_SECRET` | same panel — this is what verifies event authenticity |
| `SLACK_REDIRECT_URI` | `https://<your-domain>/api/integrations/slack/callback` |

`SLACK_SIGNING_SECRET` is required for the events endpoint. Without it
`/api/slack/events` returns 503 and never processes an event.

## 2. OAuth redirect URL

Slack app → **OAuth & Permissions** → Redirect URLs → add exactly:

```
https://<your-domain>/api/integrations/slack/callback
```

It must byte-match `SLACK_REDIRECT_URI`. The callback binds the OAuth state to
the initiating CreatorOS user and organization, so the URL registered here and
the environment variable cannot drift apart.

## 3. Bot token scopes

The install requests exactly these, from
`apps/web/src/app/api/integrations/slack/install/route.ts`:

| Scope | Why CreatorOS needs it |
| --- | --- |
| `channels:manage` | create the creator and internal channels |
| `channels:read` | find an existing channel so a retry does not create a duplicate |
| `groups:write` | create private internal channels |
| `groups:read` | same lookup, for private channels |
| `chat:write` | post the welcome message and the agent's replies |
| `users:read` | resolve Slack users when inviting them to a channel |

For the agent, also add:

| Scope | Why |
| --- | --- |
| `app_mentions:read` | receive `@Foundry` mentions |
| `im:history` | read the DM text the agent is asked to answer |
| `im:read` | resolve DM channels |
| `im:write` | reply in a DM |

### Least-privilege review of the existing app

The existing Foundry Slack app holds broader scopes than the list above,
including `assistant:write`, channel/group/DM history, and several user-token
search scopes. CreatorOS does not use any of them. Recommended, **not** applied
automatically because removing a scope from a live app breaks anything else
using it:

- **Drop the user-token search scopes.** CreatorOS never uses a user token; it
  stores and uses the bot token only. Any user token in that app is unused
  standing access to every message the installing user can read.
- **Drop `assistant:write`.** The agent replies with `chat.postMessage` in a
  thread. It does not use the assistant surface.
- **Keep** `channels:history` / `groups:history` only if something outside
  CreatorOS needs them. The agent reads the message text delivered in the event
  payload and never calls a history API.

Removing a scope requires reinstalling the app, which issues a new bot token.
CreatorOS handles that: reinstall through **Settings → Integrations →
Reauthorize** and the new token replaces the old one in `integration_credentials`.

## 4. Connect the workspace

In CreatorOS: **Settings → Integrations → Slack → Connect**. This requires the
`integration.manage` permission (super_admin by default).

The flow: `/api/integrations/slack/install` mints a single-use state row in
`oauth_states` bound to your user, organization and redirect URI, with an
expiry. Slack redirects back to `/api/integrations/slack/callback`, which
consumes that state atomically through `consume_oauth_state()`, exchanges the
code server-side, and writes the bot token to `integration_credentials`
encrypted with `INTEGRATION_ENCRYPTION_KEY`. The token never reaches the browser
and is never logged.

## 5. Event Subscriptions (agent only)

Slack app → **Event Subscriptions** → enable, then set the Request URL to:

```
https://<your-domain>/api/slack/events
```

Slack immediately sends a signed `url_verification` challenge. The endpoint
verifies the signature *before* answering it, so the signing secret must already
be set in the deployed environment or verification fails and the URL will not
save.

Subscribe to these bot events:

- `app_mention` — `@Foundry what needs my attention today?` in a channel
- `message.im` — direct messages to the app

`app_home_opened` and `app_context_changed` are not handled yet; subscribing to
them is harmless, they are acknowledged and dropped.

The endpoint is excluded from the auth proxy (`apps/web/src/proxy.ts`) because
Slack authenticates with a request signature rather than a session cookie.

## 6. Link Slack users to CreatorOS users

**This step is mandatory and there is no UI for it yet.** A Slack user with no
mapping gets a refusal, not an answer — Slack workspace membership is not
CreatorOS authorization.

For each Foundry employee, insert a row (service-role only):

```sql
insert into public.slack_user_identities
  (organization_id, user_id, slack_team_id, slack_user_id)
values
  ('<foundry org uuid>', '<creatoros user uuid>', '<T...>', '<U...>');
```

- `slack_team_id` is the workspace id (`T…`), visible in the connection row.
- `slack_user_id` is the member id (`U…`), from the Slack profile menu →
  *Copy member ID*.

The agent runs every tool as that CreatorOS user, with that user's role. Ezra and
Payton need one row each; they must not share a mapping.

## 7. Verify

1. **Signature** — POST unsigned to `/api/slack/events`; expect `401`.
2. **Challenge** — save the Request URL in Slack; expect it to verify.
3. **Mention** — `@Foundry what needs my attention today?` in an internal
   channel. Expect a threaded reply.
4. **Deduplication** — check `slack_event_deliveries`: exactly one row per
   Slack `event_id`, however many times Slack retried.
5. **Unmapped user** — have someone without a `slack_user_identities` row
   mention the agent. Expect the "not linked" refusal, and no data.

## Failure modes

| Symptom | Cause |
| --- | --- |
| Slack shows "Your URL didn't respond" | `SLACK_SIGNING_SECRET` not set in that environment, or the domain is not reachable |
| `401` on every event | Signing secret does not match the app that sent the event |
| Events accepted, no reply | `ANTHROPIC_API_KEY` unset, or Inngest not receiving events |
| "Your Slack account isn't linked" | No `slack_user_identities` row for that Slack user |
| Agent answers twice | Two deployments serving the same Slack app against different databases |
| Replies stop after reinstall | Token rotated; reconnect through Settings → Integrations |
