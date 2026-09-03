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

/** Reasons the admin is meant to see, and the status each deserves. */
const CLIENT_ERRORS: Record<string, number> = {
  NOTION_PAGE_NOT_SHARED: 404,
  NOTION_PAGE_ARCHIVED: 409,
  NOTION_TOKEN_UNAVAILABLE: 409,
};

export async function POST(request: Request) {
  try {
    const session = await requirePermission("integration.manage");
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return NextResponse.json({ error: "INVALID_NOTION_PARENT_PAGE" }, { status: 400 });
    const configured = await configureNotionParent(
      session,
      parsed.data.parentPageId.replaceAll("-", ""),
    );
    return NextResponse.json({ status: "CONFIGURED", ...configured });
  } catch (error) {
    if (error instanceof AuthorizationError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    const code = error instanceof Error ? error.message : "";
    const status = CLIENT_ERRORS[code];
    // Anything not on the list could carry provider or database detail.
    if (status) return NextResponse.json({ error: code }, { status });
    return NextResponse.json({ error: "NOTION_CONFIGURATION_FAILED" }, { status: 500 });
  }
}
