import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { disconnectIntegration } from "@/lib/integration-registry";

const providerSchema = z.enum(["slack", "notion"]);

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ provider: string }> },
) {
  try {
    const session = await requirePermission("integration.manage");
    const parsed = providerSchema.safeParse((await context.params).provider);
    if (!parsed.success) return NextResponse.json({ error: "UNKNOWN_PROVIDER" }, { status: 404 });
    await disconnectIntegration(session, parsed.data.toUpperCase() as "SLACK" | "NOTION");
    return NextResponse.json({ status: "DISCONNECTED" });
  } catch (error) {
    if (error instanceof AuthorizationError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "DISCONNECT_FAILED" }, { status: 500 });
  }
}
