import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getEnvironment, targetsProductionDatabaseFromPreview } from "@/lib/environment";
import type { Database } from "@/lib/supabase/database.types";

export function createSupabaseAdminClient() {
  const environment = getEnvironment();
  // Enforced at the point the privileged client is built, not only at build
  // time: a preview deployment that reaches the production database with the
  // service role bypasses RLS on real Foundry records.
  if (targetsProductionDatabaseFromPreview(environment))
    throw new Error(
      "PREVIEW_DEPLOYMENT_TARGETS_PRODUCTION_DATABASE: refusing to create a service-role client.",
    );
  const url = environment.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = environment.SUPABASE_SECRET_KEY ?? environment.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return null;
  return createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}
