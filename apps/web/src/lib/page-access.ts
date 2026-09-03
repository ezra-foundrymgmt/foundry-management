import "server-only";
import type { Permission } from "@creatoros/domain";
import { hasPermission } from "@creatoros/domain";
import { getSession, type AppSession } from "@/lib/auth";

export type PageAccess =
  | { allowed: true; session: AppSession }
  | { allowed: false; reason: "AUTHENTICATION_REQUIRED" | "PERMISSION_DENIED" };

/**
 * Route middleware only proves that *somebody* is signed in. Role checks have to
 * happen per page as well, otherwise any authenticated member of the tenant can
 * read pages their role does not grant — the audit log and unit economics being
 * the obvious examples.
 */
export async function authorizePage(permission: Permission): Promise<PageAccess> {
  const session = await getSession().catch(() => null);
  if (!session) return { allowed: false, reason: "AUTHENTICATION_REQUIRED" };
  if (!hasPermission(session.role, permission)) return { allowed: false, reason: "PERMISSION_DENIED" };
  return { allowed: true, session };
}
