# Notion setup

CreatorOS projects a read-only creator hub into Notion. **CreatorOS remains the
source of truth.** There is no two-way sync and none is planned: Notion is a
projection target and a knowledge surface, not a system of record.

Status: **code complete, never exercised against live Notion.** Every step below
is a human action.

## 1. Choose an auth mode

Both are implemented. The provider abstraction is identical either way, so
starting with an internal integration does not block a later move to OAuth.

**Internal integration token (recommended to start).** Foundry-only, no OAuth
round trip. Create the integration at <https://www.notion.so/my-integrations>,
copy the secret, and store it as the Notion connection's credential.

**OAuth (multi-workspace).** Set `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` and
`NOTION_REDIRECT_URI`, and register the redirect URL:

```
https://<your-domain>/api/integrations/notion/callback
```

Either way the secret is held server-side, encrypted with
`INTEGRATION_ENCRYPTION_KEY` in `integration_credentials`, and never reaches the
browser or the logs.

## 2. Capabilities

The integration needs, at minimum:

- **Read content** — reconcile an existing hub page before creating a new one
- **Insert content** — create the hub and append updates
- **Update content** — archive a hub on offboarding

It does **not** need user information beyond the bot identity, and CreatorOS
never requests user email scopes.

## 3. Create and share the Creator Hub root

The root page is **configuration, not a constant** — nothing is hard-coded.
Create a page to hold creator hubs, e.g.:

```
Foundry
└── Creators          ← this page is the Creator Hub root
    └── Madison Carter · Creator Hub     (created by CreatorOS)
```

Then **share that page with the integration** (Notion page → Connections → add
your integration). Notion integrations see nothing until a page is explicitly
shared, and the share is inherited by child pages.

## 4. Configure the root in CreatorOS

**Settings → Integrations → Notion → Creator Hub root**, and paste the page ID.
It is stored in `integration_connections.configuration_json.parentPageId` for
that organization.

Until it is set, `createLiveOnboardingService()` throws
`NOTION_PARENT_PAGE_NOT_CONFIGURED` and creator activation stops before it
provisions anything. That is intentional: activation should fail loudly rather
than scatter hub pages into the workspace root.

## 5. What gets projected

`LiveNotionProvider` creates two pages per creator:

| Page | Audience |
| --- | --- |
| `<Stage name> · Creator Hub` | creator-readable |
| `<Stage name> · Internal Operations` | Foundry only |

Updates to the creator hub pass `assertProjectableFields()` in
`packages/integrations/src/projection.ts`, which is an **allowlist**:

```
status, welcome, currentPriorities, thisWeek, creatorDeliverables,
foundryDeliverables, contentRequests, approvals, approvedGrowthStrategy,
performanceSummary, upcomingMeetings, resources
```

A field that is not on that list is refused. A field on the list whose *value*
mentions contribution margin, P&L, unit economics, commission rate, Foundry
revenue, employee QA, founder notes, legal analysis, internal incidents, or
anything credential-shaped is also refused.

It **refuses rather than redacts**. Truncating restricted content still leaks
the part that fit and hides that a caller tried to project it at all.

This is an allowlist by design: a blocklist silently leaks every field someone
forgets to add to it, and new internal fields get added to CreatorOS routinely.

## 6. Idempotency, and its one residual gap

Page ids are persisted in `provisioned_resources` under a deterministic key
(`creator:<id>:notion:creator-hub:v1`), unique per organization. A retry finds
the stored id and reuses the page — you do not get "Madison Hub 2".

The store lookup is the primary guard. Behind it, `#findPage()` reconciles by
exact title under the configured root, which covers the crash window between
creating a page in Notion and persisting its id.

**Residual gap, stated honestly:** Notion's search index is eventually
consistent. If the process dies within the indexing window *and* retries within
it, the reconcile can miss the orphaned page and create a second one. Notion
offers no create-if-absent and no `name_taken` equivalent, so this window cannot
be fully closed from the client. It is narrow and self-healing on a later retry.
If you see a duplicate hub, archive it in Notion; the stored id is authoritative.

## 7. Verify

1. Root configured — Settings shows the Creator Hub root.
2. Health check — Settings → Integrations → Notion → Health returns OK.
3. Activation — run a fictional creator's activation, confirm two pages appear
   under the root.
4. Idempotency — retry activation; no new pages.
5. Boundary — attempt to project `founderNotes`; expect
   `NOTION_PROJECTION_REFUSED` and nothing written.

## Failure modes

| Symptom | Cause |
| --- | --- |
| `NOTION_PARENT_PAGE_NOT_CONFIGURED` | Creator Hub root not set for that organization |
| `NOTION_object_not_found` | Root page not shared with the integration |
| `NOTION_unauthorized` | Token revoked or wrong workspace; reconnect |
| `NOTION_PROJECTION_REFUSED` | Correct behaviour — restricted content was blocked |
| Duplicate hub page | The search-index window above; archive the extra page |
