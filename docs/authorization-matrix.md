# CreatorOS V1 authorization matrix

The browser has no direct database access at all, read or write. Migration `202609020012_close_postgrest_read_bypass.sql` revoked `select` from `authenticated` on every table but one: `organization_memberships`, scoped to the caller's own row so `getSession()` can resolve which organization and role they hold before any permission check runs. Every page and route reads and writes through the server-held service-role key after that role check — RLS's tenant-isolation policy is no longer what stands between one organization's data and another's; the role check and the server-side organization scoping are. Every privileged route authenticates the Supabase user, resolves exactly one active database membership, checks the role permission, scopes the target lookup to the membership organization, validates input, mutates with the server-only database key, and appends an audit event where applicable.

| Capability              | Super admin | Growth | Creator success | Fan ops      | Editor       | Analyst | Finance      | Contractor   | Viewer |
| ----------------------- | ----------- | ------ | --------------- | ------------ | ------------ | ------- | ------------ | ------------ | ------ |
| Read creators/prospects | Yes         | Yes    | Yes             | Creator only | Creator only | Yes     | Creator only | Creator only | Yes    |
| Convert prospect        | Yes         | No     | No              | No           | No           | No      | No           | No           | No     |
| Start/retry activation  | Yes         | No     | Yes             | No           | No           | No      | No           | No           | No     |
| Manage Slack/Notion     | Yes         | No     | No              | No           | No           | No      | No           | No           | No     |
| Read analytics          | Yes         | Yes    | Yes             | Yes          | Yes          | Yes     | Yes          | No           | Yes    |
| Update finance          | Yes         | No     | No              | No           | No           | No      | Yes          | No           | No     |
| Read audit              | Yes         | No     | No              | No           | No           | No      | No           | No           | No     |
| Manage users/settings   | Yes         | No     | No              | No           | No           | No      | No           | No           | No     |

Authorization is not read from `auth.users.app_metadata`. Database membership is canonical so role changes and deactivation take effect without issuing a new token.
