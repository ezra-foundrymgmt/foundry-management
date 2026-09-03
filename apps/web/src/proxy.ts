import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Whether this process is a developer's machine running mock mode.
 *
 * Deliberately not `(MODE ?? "mock") === "mock"`. That default meant "skip
 * authentication" — so if the variable failed to reach the middleware runtime,
 * which resolves its environment separately from the page and route functions,
 * every route would be served with no session check. The failure mode of an
 * absent variable has to be "enforce", not "skip".
 *
 * The zod contract is not imported here on purpose: the edge runtime should not
 * depend on a module that throws during parsing. The three conditions below are
 * the same ones isDeployedEnvironment() applies.
 */
export function isDeveloperMockMode(): boolean {
  if (process.env["VERCEL_ENV"]) return false;
  if ((process.env["APP_ENV"] ?? "development") !== "development") return false;
  return process.env["CREATOROS_INTEGRATION_MODE"] === "mock";
}

export async function proxy(request: NextRequest) {
  if (isDeveloperMockMode()) return NextResponse.next();
  let response = NextResponse.next({ request });
  const isLogin = request.nextUrl.pathname === "/login";
  const isAuthCallback = request.nextUrl.pathname === "/auth/callback";
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const key = process.env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"];
  if (!url || !key) {
    // /login is where this redirect points, so redirecting it again is an
    // infinite loop and the operator never sees the reason. They get the page
    // and its error banner instead.
    if (isLogin) return response;
    return NextResponse.redirect(new URL("/login?error=not-configured", request.url));
  }
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
