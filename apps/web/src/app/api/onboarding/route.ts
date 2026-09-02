import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { allowRequest } from "@/lib/rate-limit";
import { onboardingCreators, onboardingService } from "@/lib/onboarding";
import { isMockMode } from "@/lib/environment";
import { inngest } from "@/lib/inngest";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getCorrelationId, logEvent } from "@/lib/observability";
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
      const admin = createSupabaseAdminClient();
      if (!admin) return NextResponse.json({ error: "DATABASE_NOT_CONFIGURED" }, { status: 503 });
      const creator = await admin
        .from("creators")
        .select("id,organization_id")
        .eq("id", parsed.data.creatorId)
        .eq("organization_id", session.organizationId)
        .maybeSingle();
      if (creator.error) throw new Error(creator.error.message);
      if (!creator.data) return NextResponse.json({ error: "CREATOR_NOT_FOUND" }, { status: 404 });
      const liveCreator = z.object({ id: z.string().uuid() }).parse(creator.data);
      const idempotencyKey = `creator:${liveCreator.id}:activation:v1`;
      const result = await inngest.send({
        id: idempotencyKey,
        name: "creator.activation.requested",
        data: {
          organizationId: session.organizationId,
          creatorId: liveCreator.id,
          actorUserId: session.userId,
          idempotencyKey,
        },
      });
      logEvent("info", "creator.activation.queued", {
        correlationId: requestCorrelationId,
        organizationId: session.organizationId,
        creatorId: liveCreator.id,
        actorUserId: session.userId,
      });
      return NextResponse.json(
        { status: "QUEUED", eventIds: result.ids, idempotencyKey },
        { status: 202 },
      );
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
    logEvent("error", "creator.activation.request_failed", {
      correlationId: requestCorrelationId,
      error: error instanceof Error ? error.message : "UNKNOWN",
    });
    if (error instanceof AuthorizationError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "ONBOARDING_START_FAILED" }, { status: 500 });
  }
}
