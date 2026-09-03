import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { allowRequest } from "@/lib/rate-limit";
import { isMockMode } from "@/lib/environment";
import { getCorrelationId, logEvent } from "@/lib/observability";
import { ProspectError, prospectUpdateSchema, updateProspect } from "@/lib/prospects";

const idSchema = z.string().uuid();

export async function PATCH(
  request: Request,
  context: { params: Promise<{ prospectId: string }> },
) {
  const correlationId = getCorrelationId(request);
  try {
    const session = await requirePermission("prospect.update");
    if (!(await allowRequest(`${session.userId}:prospect-update`, 60)))
      return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
    if (isMockMode())
      return NextResponse.json({ error: "WRITES_REQUIRE_LIVE_MODE" }, { status: 503 });

    const prospectId = idSchema.safeParse((await context.params).prospectId);
    if (!prospectId.success)
      return NextResponse.json({ error: "INVALID_PROSPECT_ID" }, { status: 400 });

    const parsed = prospectUpdateSchema.safeParse(await request.json());
    if (!parsed.success)
      return NextResponse.json(
        { error: "INVALID_INPUT", issues: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );

    // Ownership is established inside updateProspect from the session's
    // organization; a prospect id from another tenant resolves to nothing.
    const prospect = await updateProspect(session, prospectId.data, parsed.data);
    logEvent("info", "prospect.updated", {
      correlationId,
      organizationId: session.organizationId,
      prospectId: prospectId.data,
    });
    return NextResponse.json({ prospect });
  } catch (error) {
    if (error instanceof AuthorizationError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof ProspectError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    logEvent("error", "prospect.update_failed", {
      correlationId,
      error: error instanceof Error ? error.message : "UNKNOWN",
    });
    return NextResponse.json({ error: "PROSPECT_UPDATE_FAILED" }, { status: 500 });
  }
}
