import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getEnvironment } from "@/lib/environment";
import type { Database } from "@/lib/supabase/database.types";

export function createSupabaseAdminClient() {
  const environment = getEnvironment();
  const url = environment.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = environment.SUPABASE_SECRET_KEY ?? environment.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return null;
  return createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}
