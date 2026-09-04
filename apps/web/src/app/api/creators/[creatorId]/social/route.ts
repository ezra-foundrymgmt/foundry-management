import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import {
  SocialImportError,
  importCreatorSocialPosts,
  socialImportSchema,
} from "@/lib/social-import";
import { captureException, getCorrelationId, logEvent } from "@/lib/observability";

export async function POST(request: Request, context: { params: Promise<{ creatorId: string }> }) {
  const correlationId = getCorrelationId(request);
  try {
    /**
     * `creator.update`, not `finance.update`.
     *
     * Reach and profile visits are not financial figures, and copying the
     * revenue route's gate would have handed social ingestion to `finance`
     * (which holds no creator-write permission at all) while withholding it
     * from `creator_success`, the role that actually manages a creator's
     * record. This matches the baseline route, which gates the other
     * creator-scoped measurement write the same way.
     */
    const session = await requirePermission("creator.update");
    const creatorId = z
      .string()
      .uuid()
      .parse((await context.params).creatorId);
    const body = socialImportSchema.safeParse(await request.json());
    if (!body.success)
      return NextResponse.json(
        { error: "INVALID_INPUT", issues: body.error.flatten().fieldErrors },
        { status: 400 },
      );
    const result = await importCreatorSocialPosts(session, creatorId, body.data);
    logEvent("info", "creator.social.imported", {
      correlationId,
      organizationId: session.organizationId,
      creatorId,
      rows: result.rowsWritten,
    });
    return NextResponse.json({ data: result }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthorizationError || error instanceof SocialImportError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof z.ZodError)
      return NextResponse.json({ error: "INVALID_CREATOR_ID" }, { status: 400 });
    captureException(error, { correlationId, event: "creator.social_import_failed" });
    return NextResponse.json({ error: "SOCIAL_IMPORT_FAILED" }, { status: 500 });
  }
}
