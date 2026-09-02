import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getEnvironment } from "@/lib/environment";
import { consumeOAuthState, saveIntegrationConnection } from "@/lib/integration-registry";
import { exchangeNotionCode } from "@/lib/oauth-providers";

export async function GET(request: Request) {
  const destination = new URL("/settings/integrations", request.url);
  try {
    const session = await requirePermission("integration.manage");
    const query = new URL(request.url).searchParams;
    const code = query.get("code");
    const state = query.get("state");
    if (!code || !state || query.get("error")) throw new Error("NOTION_OAUTH_DENIED");
    const redirectUri = await consumeOAuthState(session, "NOTION", state);
    const environment = getEnvironment();
    if (!environment.NOTION_CLIENT_ID || !environment.NOTION_CLIENT_SECRET)
      throw new Error("NOTION_NOT_CONFIGURED");
    const connection = await exchangeNotionCode({
      code,
      redirectUri,
      clientId: environment.NOTION_CLIENT_ID,
      clientSecret: environment.NOTION_CLIENT_SECRET,
    });
    await saveIntegrationConnection({
      session,
      provider: "NOTION",
      ...connection,
      externalWorkspaceName: connection.workspaceName,
    });
    destination.searchParams.set("connected", "notion");
  } catch {
    destination.searchParams.set("error", "notion-callback");
  }
  return NextResponse.redirect(destination);
}
