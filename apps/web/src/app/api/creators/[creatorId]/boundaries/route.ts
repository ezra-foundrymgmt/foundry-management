import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { BoundaryError, boundaryCreateSchema, createBoundary, listBoundaries } from "@/lib/boundaries";
import { captureException, getCorrelationId, logEvent } from "@/lib/observability";

const idSchema = z.string().uuid();

export async function GET(_request: Request, context: { params: Promise<{ creatorId: string }> }) {
  try {
    const session = await requirePermission("creator.read");
    const creatorId = idSchema.parse((await context.params).creatorId);
    return NextResponse.json({ data: await listBoundaries(session, creatorId) });
  } catch (error) {
    if (error instanceof AuthorizationError || error instanceof BoundaryError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof z.ZodError)
      return NextResponse.json({ error: "INVALID_CREATOR_ID" }, { status: 400 });
    return NextResponse.json({ error: "BOUNDARY_READ_FAILED" }, { status: 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ creatorId: string }> }) {
  const correlationId = getCorrelationId(request);
  try {
    // Recording what a creator will not do is a change to the creator record,
    // so it takes creator.update rather than a task-level permission.
    const session = await requirePermission("creator.update");
    const creatorId = idSchema.parse((await context.params).creatorId);
    const body = boundaryCreateSchema.safeParse(await request.json());
    if (!body.success)
      return NextResponse.json(
        { error: "INVALID_INPUT", issues: body.error.flatten().fieldErrors },
        { status: 400 },
      );
    const boundary = await createBoundary(session, creatorId, body.data);
    logEvent("info", "creator.boundary.recorded", {
      correlationId,
      organizationId: session.organizationId,
      creatorId,
    });
    return NextResponse.json({ data: boundary }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthorizationError || error instanceof BoundaryError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof z.ZodError)
      return NextResponse.json({ error: "INVALID_CREATOR_ID" }, { status: 400 });
    captureException(error, { correlationId, event: "creator.boundary_create_failed" });
    return NextResponse.json({ error: "BOUNDARY_CREATE_FAILED" }, { status: 500 });
  }
}
