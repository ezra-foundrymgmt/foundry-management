export const PERMISSIONS = [
  "creator.read",
  "creator.create",
  "creator.update",
  "creator.archive",
  "prospect.read",
  "prospect.create",
  "prospect.update",
  "application.read",
  "application.review",
  "workflow.start",
  "workflow.retry",
  "workflow.cancel",
  "task.create",
  "task.assign",
  "task.complete",
  "analytics.read",
  "finance.read",
  "finance.update",
  "integration.read",
  "integration.manage",
  "audit.read",
  "settings.manage",
  "user.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];
export type Role =
  | "super_admin"
  | "growth"
  | "creator_success"
  | "fan_ops"
  | "editor"
  | "analyst"
  | "finance"
  | "contractor"
  | "viewer";

const readPermissions: Permission[] = [
  "creator.read",
  "prospect.read",
  "application.read",
  "analytics.read",
  "integration.read",
];
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  super_admin: PERMISSIONS,
  growth: [
    ...readPermissions,
    "prospect.create",
    "prospect.update",
    "task.create",
    "task.complete",
  ],
  creator_success: [
    ...readPermissions,
    "creator.update",
    "application.review",
    "workflow.start",
    "workflow.retry",
    "task.create",
    "task.assign",
    "task.complete",
  ],
  fan_ops: ["creator.read", "task.create", "task.complete", "analytics.read"],
  editor: ["creator.read", "task.complete", "analytics.read"],
  analyst: readPermissions,
  finance: ["creator.read", "analytics.read", "finance.read", "finance.update"],
  contractor: ["creator.read", "task.complete"],
  viewer: readPermissions,
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
