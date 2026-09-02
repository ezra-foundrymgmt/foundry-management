import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { configureNotionParent } from "@/lib/integration-registry";

const schema = z.object({
  parentPageId: z
    .string()
    .trim()
    .regex(/^[a-fA-F0-9-]{32,36}$/),
});

export async function POST(request: Request) {
  try {
    const session = await requirePermission("integration.manage");
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return NextResponse.json({ error: "INVALID_NOTION_PARENT_PAGE" }, { status: 400 });
    await configureNotionParent(session, parsed.data.parentPageId.replaceAll("-", ""));
    return NextResponse.json({ status: "CONFIGURED" });
  } catch (error) {
    if (error instanceof AuthorizationError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "NOTION_CONFIGURATION_FAILED" }, { status: 500 });
  }
}
