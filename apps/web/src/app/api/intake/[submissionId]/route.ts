import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import {
  IntakeError,
  applyIntakeSubmission,
  matchIntakeSubmission,
  rejectIntakeSubmission,
} from "@/lib/creator-intake";
import { captureException, getCorrelationId, logEvent } from "@/lib/observability";

/**
 * The authenticated half of intake. Everything that writes to a creator record
 * comes through here, behind a session and a permission.
 *
 * The action is an explicit discriminant rather than something inferred from
 * which keys the body happens to carry. `api/creators/[creatorId]` dispatches by
 * sniffing keys and it silently misrouted two fields into a schema that
 * rejected them, so every attempt to answer two activation gates returned 400
 * and wrote nothing. A named action cannot fail that way.
 */
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("apply") }),
  z.object({ action: z.literal("reject"), reason: z.string().trim().min(1).max(500) }),
  z.object({ action: z.literal("match"), creatorId: z.string().uuid() }),
]);

export async function POST(
  request: Request,
  context: { params: Promise<{ submissionId: string }> },
) {
  const correlationId = getCorrelationId(request);
  try {
    // Applying writes a creator's boundaries, brand profile and compliance
    // evidence, so it takes the same permission as any other creator edit.
    const session = await requirePermission("creator.update");
    const submissionId = z
      .string()
      .uuid()
      .parse((await context.params).submissionId);
    const body = schema.safeParse(await request.json());
    if (!body.success)
      return NextResponse.json(
        { error: "INVALID_INPUT", issues: body.error.flatten().fieldErrors },
        { status: 400 },
      );

    if (body.data.action === "apply") {
      const result = await applyIntakeSubmission(session, submissionId);
      logEvent("info", "creator.intake.applied", {
        correlationId,
        organizationId: session.organizationId,
        creatorId: result.creatorId,
      });
      return NextResponse.json(result);
    }

    if (body.data.action === "reject")
      return NextResponse.json(
        await rejectIntakeSubmission(session, submissionId, body.data.reason),
      );

    return NextResponse.json(
      await matchIntakeSubmission(session, submissionId, body.data.creatorId),
    );
  } catch (error) {
    if (error instanceof AuthorizationError || error instanceof IntakeError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof z.ZodError)
      return NextResponse.json({ error: "INVALID_SUBMISSION_ID" }, { status: 400 });
    captureException(error, { correlationId, event: "creator.intake.action_failed" });
    return NextResponse.json({ error: "INTAKE_ACTION_FAILED" }, { status: 500 });
  }
}
