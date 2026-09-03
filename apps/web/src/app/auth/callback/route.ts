import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next");
  // Browsers normalise a backslash to a forward slash in a URL's authority, so
  // "/\evil.com" and "/\\evil.com" pass a naive startsWith("/") check and then
  // navigate off-site. Require a single leading slash followed by something that
  // is neither a slash nor a backslash.
  const destination = next && /^\/(?![/\\])/.test(next) ? next : "/";
  if (code) {
    const client = await createSupabaseServerClient();
    const result = client
      ? await client.auth.exchangeCodeForSession(code)
      : { error: new Error("not configured") };
    if (!result.error) return NextResponse.redirect(new URL(destination, request.url));
  }
  return NextResponse.redirect(new URL("/login?error=auth-callback", request.url));
}
