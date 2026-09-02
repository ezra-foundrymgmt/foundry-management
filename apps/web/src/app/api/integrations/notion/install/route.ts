import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { getEnvironment, isMockMode } from "@/lib/environment";
import { registerOAuthState } from "@/lib/integration-registry";

export async function GET(request: Request) {
  try {
    const session = await requirePermission("integration.manage");
    if (isMockMode())
      return NextResponse.redirect(new URL("/settings/integrations?notice=mock", request.url));
    const environment = getEnvironment();
    if (!environment.NOTION_CLIENT_ID || !environment.NOTION_REDIRECT_URI)
      return NextResponse.redirect(
        new URL("/settings/integrations?error=notion-not-configured", request.url),
      );
    const state = await registerOAuthState(session, "NOTION", environment.NOTION_REDIRECT_URI);
    const authorize = new URL("https://api.notion.com/v1/oauth/authorize");
    authorize.searchParams.set("client_id", environment.NOTION_CLIENT_ID);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("owner", "user");
    authorize.searchParams.set("redirect_uri", environment.NOTION_REDIRECT_URI);
    authorize.searchParams.set("state", state);
    return NextResponse.redirect(authorize);
  } catch (error) {
    if (error instanceof AuthorizationError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.redirect(
      new URL("/settings/integrations?error=notion-install", request.url),
    );
  }
}
