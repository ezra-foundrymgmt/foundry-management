import { hasPermission, type Permission, type Role } from "@creatoros/domain";
import { z } from "zod";

export const membershipSchema = z.object({
  organization_id: z.string().uuid(),
  role: z.enum([
    "super_admin",
    "growth",
    "creator_success",
    "fan_ops",
    "editor",
    "analyst",
    "finance",
    "contractor",
    "viewer",
  ]),
  active: z.literal(true),
});

export type ActiveMembership = z.infer<typeof membershipSchema>;

export function selectSingleActiveMembership(input: unknown): ActiveMembership | null {
  const parsed = z.array(membershipSchema).safeParse(input);
  return parsed.success && parsed.data.length === 1 ? (parsed.data[0] ?? null) : null;
}

export function authorizeRole(role: Role, permission: Permission): void {
  if (!hasPermission(role, permission)) throw new AuthorizationError("PERMISSION_DENIED", 403);
}

export function assertSameOrganization(
  sessionOrganizationId: string,
  resourceOrganizationId: string,
) {
  if (sessionOrganizationId !== resourceOrganizationId)
    throw new AuthorizationError("RESOURCE_ORGANIZATION_MISMATCH", 403);
}

export class AuthorizationError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
  }
}
