# CreatorOS V1 live verification gates

Use only these labels in a release report:

- **LIVE VERIFIED** — exercised successfully against the intended external staging or production service.
- **CODE COMPLETE / CREDENTIAL BLOCKED** — production path and local tests pass, but a missing credential, account, callback registration, or privileged deployment access prevents a live run.
- **MOCK VERIFIED** — deterministic mock path passes but no live provider assertion is made.
- **NOT IMPLEMENTED** — no production path exists.

## Required gates

1. Fresh real Supabase project accepts all migrations without manual SQL edits; production seed is not loaded.
2. Ezra and Payton can sign in through separate accounts and inactive users cannot.
3. Direct authenticated SQL/API reads cannot see another organization; browser writes fail; server mutations reject a cross-organization resource ID.
4. Viewer, contractor, analyst, growth, creator-success, finance, and super-admin API permissions match the matrix.
5. Slack OAuth rejects missing, expired, replayed, wrong-user, and wrong-organization state. Health check passes. Repeated activation returns the same channel IDs.
6. Notion OAuth passes the same state tests. Parent-page configuration is required. Repeated activation returns the same page IDs and projects no sensitive creator fields.
7. Inngest rejects invalid signatures, accepts current and configured fallback keys during rotation, retries a forced provider failure, and resumes without replaying succeeded steps.
8. Vercel Preview uses staging services; Production uses production services. `/api/health`, `/api/inngest`, login redirects, and OAuth callbacks are reachable on HTTPS.
9. Manifest and 192/512 icons return correctly. Install CreatorOS in Chrome/Edge and verify that a signed-out launch reaches login.
10. Lint, typecheck, unit, migration replay, end-to-end, production build, and dependency audit all pass at the release commit.
