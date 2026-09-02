import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next");
  const destination = next?.startsWith("/") && !next.startsWith("//") ? next : "/";
  if (code) {
    const client = await createSupabaseServerClient();
    const result = client
      ? await client.auth.exchangeCodeForSession(code)
      : { error: new Error("not configured") };
    if (!result.error) return NextResponse.redirect(new URL(destination, request.url));
  }
  return NextResponse.redirect(new URL("/login?error=auth-callback", request.url));
}
