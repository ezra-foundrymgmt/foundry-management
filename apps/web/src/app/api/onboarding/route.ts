import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { allowRequest } from "@/lib/rate-limit";
import { onboardingCreators, onboardingService } from "@/lib/onboarding";
import { isMockMode } from "@/lib/environment";
import { startCreatorActivation } from "@/lib/activation-commands";
import { captureException, getCorrelationId } from "@/lib/observability";
const schema = z.object({ creatorId: z.string().min(1).max(100) });
export async function POST(request: Request) {
  const requestCorrelationId = getCorrelationId(request);
  try {
    const session = await requirePermission("workflow.start");
    if (!(await allowRequest(`${session.userId}:onboarding`, 5)))
      return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return NextResponse.json(
        { error: "INVALID_INPUT", issues: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    if (!isMockMode()) {
      // Queued through the same service the Foundry agent calls, so there is one
      // set of rules for who may activate whom.
      const queued = await startCreatorActivation(session, {
        creatorId: parsed.data.creatorId,
        correlationId: requestCorrelationId,
      });
      return NextResponse.json(queued, { status: 202 });
    }
    const creator = onboardingCreators[parsed.data.creatorId];
    if (!creator) return NextResponse.json({ error: "CREATOR_NOT_FOUND" }, { status: 404 });
    const run = await onboardingService.start(creator);
    return NextResponse.json({
      run,
      audit: {
        action: "creator.onboarding.started",
        actorUserId: session.userId,
        resourceId: creator.id,
        correlationId: run.correlationId,
      },
    });
  } catch (error) {
    // A denied permission is an expected outcome, not an exception: reporting it
    // would fill the error channel with normal authorization traffic.
    if (error instanceof AuthorizationError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof Error && error.message === "CREATOR_NOT_FOUND")
      return NextResponse.json({ error: "CREATOR_NOT_FOUND" }, { status: 404 });
    if (error instanceof Error && error.message === "DATABASE_NOT_CONFIGURED")
      return NextResponse.json({ error: "DATABASE_NOT_CONFIGURED" }, { status: 503 });
    captureException(error, {
      correlationId: requestCorrelationId,
      event: "creator.activation.request_failed",
    });
    return NextResponse.json({ error: "ONBOARDING_START_FAILED" }, { status: 500 });
  }
}
