import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { allowRequest } from "@/lib/rate-limit";
import { resumeCreatorActivation } from "@/lib/activation-commands";
import { captureException, getCorrelationId } from "@/lib/observability";

const schema = z.object({ creatorId: z.string().uuid() });

/** Reasons the caller is allowed to see, and the status each deserves. */
const CLIENT_ERRORS: Record<string, number> = {
  NO_RESUMABLE_RUN: 404,
  RESUME_REQUIRES_LIVE_MODE: 503,
  DATABASE_NOT_CONFIGURED: 503,
};

/**
 * Resumes an activation that is parked in WAITING_EXTERNAL (baseline data has
 * since arrived) or that failed and has been repaired.
 *
 * The queueing itself lives in resumeCreatorActivation, which the Foundry agent
 * also calls, so the model cannot reach a different resume path than this one.
 */
export async function POST(request: Request) {
  const correlationId = getCorrelationId(request);
  try {
    const session = await requirePermission("workflow.retry");
    if (!(await allowRequest(`${session.userId}:workflow-resume`, 5)))
      return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return NextResponse.json(
        { error: "INVALID_INPUT", issues: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );

    const queued = await resumeCreatorActivation(session, {
      creatorId: parsed.data.creatorId,
      correlationId,
    });
    return NextResponse.json(queued, { status: 202 });
  } catch (error) {
    if (error instanceof AuthorizationError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    const status = error instanceof Error ? CLIENT_ERRORS[error.message] : undefined;
    if (status) return NextResponse.json({ error: (error as Error).message }, { status });
    captureException(error, { correlationId, event: "creator.activation.resume_failed" });
    return NextResponse.json({ error: "WORKFLOW_RESUME_FAILED" }, { status: 500 });
  }
}
