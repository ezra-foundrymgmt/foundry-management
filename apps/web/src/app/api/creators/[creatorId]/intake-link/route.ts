import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { IntakeError, issueIntakeLink } from "@/lib/creator-intake";
import { allowRequest } from "@/lib/rate-limit";
import { captureException, getCorrelationId, logEvent } from "@/lib/observability";

/**
 * Mints the link a creator opens to fill in her Model Information Sheet.
 *
 * Issuing is a creator edit rather than a read: it puts a live reference code
 * into circulation, and every code issued is another string that will match a
 * submission. Rate limited for the same reason.
 */
export async function POST(request: Request, context: { params: Promise<{ creatorId: string }> }) {
  const correlationId = getCorrelationId(request);
  try {
    const session = await requirePermission("creator.update");
    const creatorId = z
      .string()
      .uuid()
      .parse((await context.params).creatorId);
    if (!(await allowRequest(`${session.userId}:intake-link`, 20)))
      return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });

    const link = await issueIntakeLink(session, creatorId);
    logEvent("info", "creator.intake_link.issued", {
      correlationId,
      organizationId: session.organizationId,
      creatorId,
    });
    return NextResponse.json(link, { status: 201 });
  } catch (error) {
    if (error instanceof AuthorizationError || error instanceof IntakeError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof z.ZodError)
      return NextResponse.json({ error: "INVALID_CREATOR_ID" }, { status: 400 });
    captureException(error, { correlationId, event: "creator.intake_link.failed" });
    return NextResponse.json({ error: "INTAKE_LINK_FAILED" }, { status: 500 });
  }
}
