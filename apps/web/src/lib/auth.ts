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

export async function getSession(): Promise<AppSession | null> {
  if (isMockMode()) {
    return {
      userId: "demo-super-admin",
      organizationId: "00000000-0000-4000-8000-000000000001",
      role: "super_admin",
      email: "admin@foundry.demo",
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

export async function requirePermission(permission: Permission): Promise<AppSession> {
  const session = await getSession();
  if (!session) throw new AuthorizationError("AUTHENTICATION_REQUIRED", 401);
  authorizeRole(session.role, permission);
  return session;
}

export { AuthorizationError } from "@/lib/authorization";
