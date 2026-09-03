import "server-only";
import type { Permission, Role } from "@creatoros/domain";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  AuthorizationError,
  authorizeRole,
  selectSingleActiveMembership,
} from "@/lib/authorization";
import { isMockMode } from "@/lib/environment";

export interface AppSession {
  userId: string;
  organizationId: string;
  role: Role;
  email: string;
}

/**
 * Deliberately NOT the production Foundry organization id
 * (00000000-0000-4000-8000-000000000001, created by migration 0005). A
 * fabricated local session must never resolve to a real tenant, so that any
 * future code path that does reach the database from mock mode fails to find
 * data rather than silently operating on production records.
 */
export const MOCK_ORGANIZATION_ID = "ffffffff-0000-4000-8000-00000000de00";

export async function getSession(): Promise<AppSession | null> {
  if (isMockMode()) {
    return {
      userId: "demo-super-admin",
      organizationId: MOCK_ORGANIZATION_ID,
      role: "super_admin",
      email: "admin@foundry.invalid",
    };
  }
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  const memberships = await supabase
    .from("organization_memberships")
    .select("organization_id,role,active")
    .eq("user_id", data.user.id)
    .eq("active", true)
    .limit(2);
  const membership = selectSingleActiveMembership(memberships.data);
  if (memberships.error || !membership || !data.user.email) return null;
  return {
    userId: data.user.id,
    organizationId: membership.organization_id,
    role: membership.role,
    email: data.user.email,
  };
}

export async function requireSession(): Promise<AppSession> {
  const session = await getSession();
  if (!session) throw new AuthorizationError("AUTHENTICATION_REQUIRED", 401);
  return session;
}

export async function requirePermission(permission: Permission): Promise<AppSession> {
  const session = await requireSession();
  authorizeRole(session.role, permission);
  return session;
}

export { AuthorizationError } from "@/lib/authorization";
