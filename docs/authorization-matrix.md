# CreatorOS V1 authorization matrix

All browser database access is read-only and tenant-scoped by RLS. Every privileged route authenticates the Supabase user, resolves exactly one active database membership, checks the role permission, scopes the target lookup to the membership organization, validates input, mutates with the server-only database key, and appends an audit event where applicable.

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
