import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { PlannerError, buildCreatorRevenuePlan, planRequestSchema } from "@/lib/revenue-planner";
import { captureException, getCorrelationId } from "@/lib/observability";

export async function POST(request: Request, context: { params: Promise<{ creatorId: string }> }) {
  const correlationId = getCorrelationId(request);
  try {
    // Reading a plan derived from measured figures is an analytics read; it
    // writes nothing.
    const session = await requirePermission("analytics.read");
    const creatorId = z
      .string()
      .uuid()
      .parse((await context.params).creatorId);
    const body = planRequestSchema.safeParse(await request.json());
    if (!body.success)
      return NextResponse.json(
        { error: "INVALID_INPUT", issues: body.error.flatten().fieldErrors },
        { status: 400 },
      );
    return NextResponse.json(
      { data: await buildCreatorRevenuePlan(session, creatorId, body.data) },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof AuthorizationError || error instanceof PlannerError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof z.ZodError)
      return NextResponse.json({ error: "INVALID_CREATOR_ID" }, { status: 400 });
    captureException(error, { correlationId, event: "creator.plan_failed" });
    return NextResponse.json({ error: "PLAN_FAILED" }, { status: 500 });
  }
}
