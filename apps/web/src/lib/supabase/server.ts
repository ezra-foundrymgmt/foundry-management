import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

export async function createSupabaseServerClient() {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const publishableKey = process.env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"];
  if (!url || !publishableKey) return null;
  const store = await cookies();
  return createServerClient(url, publishableKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (values) => {
        try {
          values.forEach(({ name, value, options }) => store.set(name, value, options));
        } catch {
          /* Server Components cannot always write response cookies. */
        }
      },
    },
  });
}
