import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { allowRequest } from "@/lib/rate-limit";
import { isMockMode } from "@/lib/environment";
import { captureException, getCorrelationId, logEvent } from "@/lib/observability";
import {
  addProspectActivity,
  listProspectActivities,
  ProspectError,
  prospectActivitySchema,
} from "@/lib/prospects";

const idSchema = z.string().uuid();

export async function GET(request: Request, context: { params: Promise<{ prospectId: string }> }) {
  try {
    const session = await requirePermission("prospect.read");
    if (isMockMode()) return NextResponse.json({ activities: [] });
    const prospectId = idSchema.safeParse((await context.params).prospectId);
    if (!prospectId.success)
      return NextResponse.json({ error: "INVALID_PROSPECT_ID" }, { status: 400 });
    return NextResponse.json({
      activities: await listProspectActivities(session, prospectId.data),
    });
  } catch (error) {
    if (error instanceof AuthorizationError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof ProspectError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "ACTIVITY_READ_FAILED" }, { status: 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ prospectId: string }> }) {
  const correlationId = getCorrelationId(request);
  try {
    const session = await requirePermission("prospect.update");
    if (!(await allowRequest(`${session.userId}:prospect-activity`, 120)))
      return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
    if (isMockMode())
      return NextResponse.json({ error: "WRITES_REQUIRE_LIVE_MODE" }, { status: 503 });

    const prospectId = idSchema.safeParse((await context.params).prospectId);
    if (!prospectId.success)
      return NextResponse.json({ error: "INVALID_PROSPECT_ID" }, { status: 400 });

    const parsed = prospectActivitySchema.safeParse(await request.json());
    if (!parsed.success)
      return NextResponse.json(
        { error: "INVALID_INPUT", issues: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );

    const activity = await addProspectActivity(session, prospectId.data, parsed.data);
    logEvent("info", "prospect.activity_logged", {
      correlationId,
      organizationId: session.organizationId,
      prospectId: prospectId.data,
    });
    return NextResponse.json({ activity }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthorizationError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof ProspectError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    captureException(error, { correlationId, event: "prospect.activity_failed" });
    return NextResponse.json({ error: "ACTIVITY_CREATE_FAILED" }, { status: 500 });
  }
}
