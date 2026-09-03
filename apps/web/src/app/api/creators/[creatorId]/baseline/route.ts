import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { BaselineError, baselineFreezeSchema, freezeBaseline } from "@/lib/baselines";
import { captureException, getCorrelationId, logEvent } from "@/lib/observability";

export async function POST(request: Request, context: { params: Promise<{ creatorId: string }> }) {
  const correlationId = getCorrelationId(request);
  try {
    // Freezing the reference every future report is measured against is a
    // creator-record decision, not an analytics read.
    const session = await requirePermission("creator.update");
    const creatorId = z
      .string()
      .uuid()
      .parse((await context.params).creatorId);
    const body = baselineFreezeSchema.safeParse(await request.json());
    if (!body.success)
      return NextResponse.json(
        { error: "INVALID_INPUT", issues: body.error.flatten().fieldErrors },
        { status: 400 },
      );
    const baseline = await freezeBaseline(session, creatorId, body.data);
    logEvent("info", "creator.baseline.frozen", {
      correlationId,
      organizationId: session.organizationId,
      creatorId,
      version: baseline.version,
    });
    return NextResponse.json({ data: baseline }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthorizationError || error instanceof BaselineError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof z.ZodError)
      return NextResponse.json({ error: "INVALID_CREATOR_ID" }, { status: 400 });
    captureException(error, { correlationId, event: "creator.baseline_freeze_failed" });
    return NextResponse.json({ error: "BASELINE_FREEZE_FAILED" }, { status: 500 });
  }
}
