import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { getEnvironment, isMockMode } from "@/lib/environment";
import { registerOAuthState } from "@/lib/integration-registry";

const scopes = [
  "channels:manage",
  "channels:read",
  "groups:write",
  "groups:read",
  "chat:write",
  "users:read",
];

export async function GET(request: Request) {
  try {
    const session = await requirePermission("integration.manage");
    if (isMockMode())
      return NextResponse.redirect(new URL("/settings/integrations?notice=mock", request.url));
    const environment = getEnvironment();
    if (!environment.SLACK_CLIENT_ID || !environment.SLACK_REDIRECT_URI)
      return NextResponse.redirect(
        new URL("/settings/integrations?error=slack-not-configured", request.url),
      );
    const state = await registerOAuthState(session, "SLACK", environment.SLACK_REDIRECT_URI);
    const authorize = new URL("https://slack.com/oauth/v2/authorize");
    authorize.searchParams.set("client_id", environment.SLACK_CLIENT_ID);
    authorize.searchParams.set("scope", scopes.join(","));
    authorize.searchParams.set("redirect_uri", environment.SLACK_REDIRECT_URI);
    authorize.searchParams.set("state", state);
    return NextResponse.redirect(authorize);
  } catch (error) {
    if (error instanceof AuthorizationError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.redirect(
      new URL("/settings/integrations?error=slack-install", request.url),
    );
  }
}
