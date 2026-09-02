import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { getIntegrationToken, updateIntegrationHealth } from "@/lib/integration-registry";
import { checkNotionHealth, checkSlackHealth } from "@/lib/oauth-providers";

const providerSchema = z.enum(["slack", "notion"]);

export async function POST(_request: Request, context: { params: Promise<{ provider: string }> }) {
  try {
    const session = await requirePermission("integration.manage");
    const parsed = providerSchema.safeParse((await context.params).provider);
    if (!parsed.success) return NextResponse.json({ error: "UNKNOWN_PROVIDER" }, { status: 404 });
    const provider = parsed.data.toUpperCase() as "SLACK" | "NOTION";
    const connection = await getIntegrationToken(session.organizationId, provider);
    if (!connection)
      return NextResponse.json({ error: "INTEGRATION_NOT_CONNECTED" }, { status: 409 });
    const result =
      provider === "SLACK"
        ? await checkSlackHealth(connection.token)
        : await checkNotionHealth(connection.token);
    await updateIntegrationHealth(session, provider, result);
    return NextResponse.json({
      provider,
      status: result.ok ? "CONNECTED" : "DEGRADED",
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof AuthorizationError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "HEALTH_CHECK_FAILED" }, { status: 502 });
  }
}
