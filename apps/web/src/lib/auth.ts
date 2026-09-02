import "server-only";
import { hasPermission, type Permission, type Role } from "@creatoros/domain";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface AppSession {
  userId: string;
  organizationId: string;
  role: Role;
  email: string;
}

const claimsSchema = z.object({
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
});

export async function getSession(): Promise<AppSession | null> {
  if ((process.env["CREATOROS_INTEGRATION_MODE"] ?? "mock") === "mock") {
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
  const claims = claimsSchema.safeParse(data.user.app_metadata);
  if (!claims.success || !data.user.email) return null;
  return {
    userId: data.user.id,
    organizationId: claims.data.organization_id,
    role: claims.data.role,
    email: data.user.email,
  };
}

export async function requirePermission(permission: Permission): Promise<AppSession> {
  const session = await getSession();
  if (!session) throw new AuthorizationError("AUTHENTICATION_REQUIRED", 401);
  if (!hasPermission(session.role, permission))
    throw new AuthorizationError("PERMISSION_DENIED", 403);
  return session;
}

export class AuthorizationError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
  }
}
