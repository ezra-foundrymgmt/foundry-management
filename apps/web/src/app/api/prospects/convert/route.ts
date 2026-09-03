import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { captureException, getCorrelationId, logEvent } from "@/lib/observability";
import { ConversionError, convertProspect } from "@/lib/prospect-conversion";
import { allowRequest } from "@/lib/rate-limit";

const schema = z.object({ prospectId: z.string().min(1).max(100) });

export async function POST(request: Request) {
  const correlationId = getCorrelationId(request);
  try {
    const session = await requirePermission("creator.create");
    if (!(await allowRequest(`${session.userId}:prospect-conversion`, 5)))
      return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return NextResponse.json(
        { error: "INVALID_INPUT", issues: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    const result = await convertProspect({
      prospectId: parsed.data.prospectId,
      organizationId: session.organizationId,
      actorUserId: session.userId,
    });
    logEvent("info", "prospect.converted", {
      correlationId,
      organizationId: session.organizationId,
      prospectId: parsed.data.prospectId,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AuthorizationError || error instanceof ConversionError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    captureException(error, { correlationId, event: "prospect.conversion_failed" });
    return NextResponse.json({ error: "PROSPECT_CONVERSION_FAILED" }, { status: 500 });
  }
}
