import "server-only";

interface SlackOAuthResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  scope?: string;
  team?: { id?: string; name?: string };
  bot_user_id?: string;
}

export async function exchangeSlackCode(input: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}) {
  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ code: input.code, redirect_uri: input.redirectUri }),
  });
  const data = (await response.json()) as SlackOAuthResponse;
  if (!response.ok || !data.ok || !data.access_token || !data.team?.id)
    throw new Error(`SLACK_OAUTH_EXCHANGE_FAILED: ${data.error ?? response.status}`);
  return {
    accessToken: data.access_token,
    externalAccountId: data.team.id,
    workspaceName: data.team.name ?? null,
    scopes: (data.scope ?? "").split(",").filter(Boolean),
    capabilities: { botUserId: data.bot_user_id ?? null },
  };
}

interface NotionOAuthResponse {
  access_token?: string;
  workspace_id?: string;
  workspace_name?: string | null;
  bot_id?: string;
  duplicated_template_id?: string | null;
  error?: string;
  message?: string;
}

export async function exchangeNotionCode(input: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}) {
  const response = await fetch("https://api.notion.com/v1/oauth/token", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64")}`,
      "content-type": "application/json",
      "notion-version": "2026-03-11",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
    }),
  });
  const data = (await response.json()) as NotionOAuthResponse;
  if (!response.ok || !data.access_token || !data.workspace_id)
    throw new Error(`NOTION_OAUTH_EXCHANGE_FAILED: ${data.error ?? response.status}`);
  return {
    accessToken: data.access_token,
    externalAccountId: data.workspace_id,
    workspaceName: data.workspace_name ?? null,
    scopes: ["read_content", "insert_content", "update_content"],
    capabilities: {
      botId: data.bot_id ?? null,
      duplicatedTemplateId: data.duplicated_template_id ?? null,
    },
  };
}

export async function checkSlackHealth(token: string) {
  const response = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const data = (await response.json()) as {
    ok?: boolean;
    error?: string;
    team_id?: string;
    user_id?: string;
  };
  return {
    ok: response.ok && data.ok === true,
    error:
      data.error === "invalid_auth" || data.error === "token_revoked" ? "AUTH_REVOKED" : data.error,
    capabilities: { teamId: data.team_id ?? null, userId: data.user_id ?? null },
  };
}

export async function checkNotionHealth(token: string) {
  const response = await fetch("https://api.notion.com/v1/users/me", {
    headers: { authorization: `Bearer ${token}`, "notion-version": "2026-03-11" },
  });
  const data = (await response.json()) as { id?: string; type?: string; code?: string };
  return {
    ok: response.ok && typeof data.id === "string",
    error: response.status === 401 ? "AUTH_REVOKED" : data.code,
    capabilities: { botId: data.id ?? null, userType: data.type ?? null },
  };
}
