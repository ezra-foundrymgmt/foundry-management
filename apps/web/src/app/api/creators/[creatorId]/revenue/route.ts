import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { MetricsImportError, importCreatorRevenue, revenueImportSchema } from "@/lib/metrics-import";
import { captureException, getCorrelationId, logEvent } from "@/lib/observability";

export async function POST(request: Request, context: { params: Promise<{ creatorId: string }> }) {
  const correlationId = getCorrelationId(request);
  try {
    // Writing measured financial figures against a creator is a finance
    // update, not a creator-profile edit.
    const session = await requirePermission("finance.update");
    const creatorId = z
      .string()
      .uuid()
      .parse((await context.params).creatorId);
    const body = revenueImportSchema.safeParse(await request.json());
    if (!body.success)
      return NextResponse.json(
        { error: "INVALID_INPUT", issues: body.error.flatten().fieldErrors },
        { status: 400 },
      );
    const result = await importCreatorRevenue(session, creatorId, body.data);
    logEvent("info", "creator.revenue.imported", {
      correlationId,
      organizationId: session.organizationId,
      creatorId,
      rows: result.rowsWritten,
    });
    return NextResponse.json({ data: result }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthorizationError || error instanceof MetricsImportError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof z.ZodError)
      return NextResponse.json({ error: "INVALID_CREATOR_ID" }, { status: 400 });
    captureException(error, { correlationId, event: "creator.revenue_import_failed" });
    return NextResponse.json({ error: "REVENUE_IMPORT_FAILED" }, { status: 500 });
  }
}
