import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { allowRequest } from "@/lib/rate-limit";
import { isMockMode } from "@/lib/environment";
import { getCorrelationId, logEvent } from "@/lib/observability";
import { createProspect, ProspectError, prospectCreateSchema } from "@/lib/prospects";

export async function POST(request: Request) {
  const correlationId = getCorrelationId(request);
  try {
    const session = await requirePermission("prospect.create");
    if (!(await allowRequest(`${session.userId}:prospect-create`, 30)))
      return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
    if (isMockMode())
      return NextResponse.json({ error: "WRITES_REQUIRE_LIVE_MODE" }, { status: 503 });

    const parsed = prospectCreateSchema.safeParse(await request.json());
    if (!parsed.success)
      return NextResponse.json(
        { error: "INVALID_INPUT", issues: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );

    const prospect = await createProspect(session, parsed.data);
    logEvent("info", "prospect.created", {
      correlationId,
      organizationId: session.organizationId,
      prospectId: prospect.id,
    });
    return NextResponse.json({ prospect }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthorizationError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof ProspectError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    logEvent("error", "prospect.create_failed", {
      correlationId,
      error: error instanceof Error ? error.message : "UNKNOWN",
    });
    return NextResponse.json({ error: "PROSPECT_CREATE_FAILED" }, { status: 500 });
  }
}
