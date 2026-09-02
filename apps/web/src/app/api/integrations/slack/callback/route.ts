import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getEnvironment } from "@/lib/environment";
import { consumeOAuthState, saveIntegrationConnection } from "@/lib/integration-registry";
import { exchangeSlackCode } from "@/lib/oauth-providers";

export async function GET(request: Request) {
  const destination = new URL("/settings/integrations", request.url);
  try {
    const session = await requirePermission("integration.manage");
    const query = new URL(request.url).searchParams;
    const code = query.get("code");
    const state = query.get("state");
    if (!code || !state || query.get("error")) throw new Error("SLACK_OAUTH_DENIED");
    const redirectUri = await consumeOAuthState(session, "SLACK", state);
    const environment = getEnvironment();
    if (!environment.SLACK_CLIENT_ID || !environment.SLACK_CLIENT_SECRET)
      throw new Error("SLACK_NOT_CONFIGURED");
    const connection = await exchangeSlackCode({
      code,
      redirectUri,
      clientId: environment.SLACK_CLIENT_ID,
      clientSecret: environment.SLACK_CLIENT_SECRET,
    });
    await saveIntegrationConnection({
      session,
      provider: "SLACK",
      ...connection,
      externalWorkspaceName: connection.workspaceName,
    });
    destination.searchParams.set("connected", "slack");
  } catch {
    destination.searchParams.set("error", "slack-callback");
  }
  return NextResponse.redirect(destination);
}
