import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { allowRequest } from "@/lib/rate-limit";
import { onboardingCreators, onboardingService } from "@/lib/onboarding";
const schema = z.object({ creatorId: z.string().min(1).max(100) });
export async function POST(request: Request) {
  try {
    const session = await requirePermission("workflow.start");
    if (!allowRequest(`${session.userId}:onboarding`, 5))
      return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return NextResponse.json(
        { error: "INVALID_INPUT", issues: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
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
    if (error instanceof AuthorizationError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "ONBOARDING_START_FAILED" }, { status: 500 });
  }
}
