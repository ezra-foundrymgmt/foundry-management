import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isMockMode } from "@/lib/environment";
import { getCorrelationId, logEvent } from "@/lib/observability";

/**
 * POST-only: a GET sign-out is trivially triggerable by any third-party image
 * or link tag, which makes signing a user out a cross-site request forgery.
 */
export async function POST(request: Request) {
  const correlationId = getCorrelationId(request);
  const redirectTo = new URL("/login", request.url);
  if (isMockMode()) return NextResponse.redirect(redirectTo, { status: 303 });

  const supabase = await createSupabaseServerClient();
  if (supabase) {
    const { error } = await supabase.auth.signOut();
    if (error) logEvent("error", "auth.sign_out_failed", { correlationId, error: error.message });
    else logEvent("info", "auth.signed_out", { correlationId });
  }
  return NextResponse.redirect(redirectTo, { status: 303 });
}
