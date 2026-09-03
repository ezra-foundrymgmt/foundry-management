import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
  if ((process.env["CREATOROS_INTEGRATION_MODE"] ?? "mock") === "mock") return NextResponse.next();
  let response = NextResponse.next({ request });
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const key = process.env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"];
  if (!url || !key)
    return NextResponse.redirect(new URL("/login?error=not-configured", request.url));
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (values) => {
        values.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        values.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  const { data } = await supabase.auth.getUser();
  const isLogin = request.nextUrl.pathname === "/login";
  const isAuthCallback = request.nextUrl.pathname === "/auth/callback";
  if (!data.user && !isLogin && !isAuthCallback)
    return NextResponse.redirect(new URL("/login", request.url));
  if (data.user && isLogin) return NextResponse.redirect(new URL("/", request.url));
  return response;
}

export const config = {
  matcher: [
    // Exclusions are anchored at a path-segment boundary and name the exact
    // routes. A bare prefix such as `api/slack` would also exempt a future
    // /api/slack-admin or /api/slackbot route, silently shipping it without
    // authentication.
    //
    // api/slack/events is exempt because Slack authenticates with a request
    // signature rather than a session cookie; redirecting it to /login would
    // break the endpoint and Slack would retry the redirect forever. api/inngest
    // authenticates with its signing key for the same reason.
    "/((?!_next/static/|_next/image/|favicon\\.ico$|manifest\\.webmanifest$|sw\\.js$|icons/|api/health$|api/inngest$|api/inngest/|api/slack/events$).*)",
  ],
};
