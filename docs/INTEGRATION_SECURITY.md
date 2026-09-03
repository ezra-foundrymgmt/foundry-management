# Integration security

How CreatorOS handles third-party credentials and inbound requests, and what is
still unproven.

## Credential storage

Provider tokens live in `integration_credentials`, a table separate from
`integration_connections`:

```
integration_credentials(
  integration_connection_id  unique,
  ciphertext, initialization_vector, auth_tag, key_version
)
```

- **Never in `metadata_json`.** Connection metadata is queried by ordinary
  application code; ciphertext is not stored anywhere that code touches.
- **RLS enabled, and every privilege revoked** from `public`, `anon` and
  `authenticated`. Only `service_role` can read the table at all. A browser
  session holding a valid JWT gets nothing — `verify-live.mjs` asserts exactly
  this, once it can be run.
- Encrypted with AES-256-GCM using `INTEGRATION_ENCRYPTION_KEY`. The auth tag is
  stored separately, so tampered ciphertext fails to decrypt rather than
  decrypting to garbage.
- `key_version` exists for future rotation. **Rotation is not implemented:**
  changing the key invalidates every stored token and both providers must be
  reconnected.

No API route returns a token, and no agent tool selects from that table.
`logEvent` redacts any field whose key matches
`authorization|token|secret|password|cookie|key`.

## OAuth

State is stored in `oauth_states`, not in a cookie or in memory:

| Property               | How                                                                        |
| ---------------------- | -------------------------------------------------------------------------- |
| Unpredictable          | `createOAuthState()` from `node:crypto`                                    |
| Stored hashed          | only `state_hash` is persisted                                             |
| Single use             | `consume_oauth_state()` marks `consumed_at` atomically in SQL              |
| Expiring               | 10-minute `expires_at`                                                     |
| Bound to the initiator | row carries `user_id` and `organization_id`, both checked on consume       |
| Bound to the redirect  | `redirect_uri` returned from the consume, not read from the callback query |

Because consumption is a single SQL statement, two concurrent callbacks with the
same state cannot both succeed. The state row is service-role only.

The callback additionally requires `integration.manage`, so an attacker who
somehow replayed a state still needs an authenticated session with that
permission.

## Slack request authenticity

`/api/slack/events` verifies `v0=HMAC_SHA256(signing_secret, "v0:" + timestamp +
":" + raw_body)`:

- Computed over the **byte-exact raw body**. Parsing and re-serialising changes
  key order and whitespace and would break verification.
- `timingSafeEqual`, with a length check first because `timingSafeEqual` throws
  on unequal lengths and that throw would itself be an oracle.
- ±5-minute window, using an absolute difference so a future-dated timestamp is
  rejected too.
- Every failure returns an identical `401 UNAUTHORIZED`. The reason is logged
  server-side, never returned.
- The `url_verification` challenge is answered **after** verification.

11 tests cover this, including a tampered body, a foreign signing secret, a
signature bound to a different timestamp, a truncated signature, and
parsed-and-reserialised JSON.

## Replay and duplicate delivery

Slack retries anything it does not get a 2xx for within three seconds.
`claim_slack_event()` inserts into `slack_event_deliveries` with
`on conflict (slack_team_id, slack_event_id) do nothing` and returns whether the
insert happened. Only the caller that actually inserted proceeds.

Doing this in SQL rather than as a read-then-write in application code is what
makes it correct when two retries land on two instances simultaneously.

## Tenant resolution

A Slack workspace maps to an organization only through a `CONNECTED` Slack
connection with a matching `external_account_id`. An event from an unknown
workspace is acknowledged and dropped — it never defaults to an organization.

Slack workspace membership is **not** CreatorOS authorization. Tool calls run as
the CreatorOS user in `slack_user_identities`; an unmapped Slack user gets a
refusal that reveals nothing about what exists.

## Agent tool boundary

Every call passes one gate: tool exists → caller's role holds the permission →
internal-only tools refuse on a creator-facing surface → input schema validates.
Only then does anything touch the database.

There is no tool for SQL, raw HTTP, shell, file access, credentials, payouts, or
cross-tenant reads. Every query filters on the session's `organization_id`;
11 tests assert that filter is present and correct on every tool.

## Privileged client boundary

`admin.ts` bypasses RLS. Protections:

1. `import "server-only"` — pulling it into a client bundle fails the build.
2. No client component imports it, directly or transitively.
3. It refuses to construct at all when a non-production deployment resolves to
   the production Supabase project.
4. Every route using it establishes the session first and filters by
   `session.organizationId` — never by an organization id from the request.

## What is still unproven

- **No live verification of anything.** No credentials were available.
- `verify-live.mjs` — the real cross-tenant proof — has never been run.
- Encryption is tested at the `encryptSecret`/`decryptSecret` level only; the
  storage path that encrypts a real provider token has no test.
- No key rotation procedure.
- Rate limiting covers write routes; the Slack ingress and reads are unlimited.
- Slack scope minimisation is documented and recommended, not applied — see
  `docs/SLACK_SETUP.md`.
