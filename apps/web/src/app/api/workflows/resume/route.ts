import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { allowRequest } from "@/lib/rate-limit";
import { isMockMode } from "@/lib/environment";
import { inngest } from "@/lib/inngest";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getCorrelationId, logEvent } from "@/lib/observability";

const schema = z.object({ creatorId: z.string().uuid() });

/**
 * Resumes an activation that is parked in WAITING_EXTERNAL (baseline data has
 * since arrived) or that failed and has been repaired.
 *
 * The resume event deliberately carries its own idempotency key. Reusing the
 * original `creator:<id>:activation:v1` key would make Inngest deduplicate the
 * resume against the initial request and silently drop it, so a run could never
 * be resumed twice. Safety against concurrent resumes comes from the database
 * instead: workflow_runs_one_active_creator_definition_uidx permits only one
 * non-terminal run per creator, and provisioned_resources is keyed by a
 * per-resource idempotency key.
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
    if (isMockMode())
      return NextResponse.json({ error: "RESUME_REQUIRES_LIVE_MODE" }, { status: 503 });

    const admin = createSupabaseAdminClient();
    if (!admin) return NextResponse.json({ error: "DATABASE_NOT_CONFIGURED" }, { status: 503 });

    // Ownership is proven from the session's organization, never from the body.
    const run = await admin
      .from("workflow_runs")
      .select("id,status")
      .eq("organization_id", session.organizationId)
      .eq("creator_id", parsed.data.creatorId)
      .not("status", "in", "(SUCCEEDED,CANCELLED)")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (run.error) throw new Error(run.error.message);
    if (!run.data) return NextResponse.json({ error: "NO_RESUMABLE_RUN" }, { status: 404 });

    const resumable = z.object({ id: z.string().uuid(), status: z.string() }).parse(run.data);
    const result = await inngest.send({
      id: `creator:${parsed.data.creatorId}:activation:resume:${resumable.id}:${correlationId}`,
      name: "creator.activation.resume",
      data: {
        organizationId: session.organizationId,
        creatorId: parsed.data.creatorId,
        actorUserId: session.userId,
        idempotencyKey: `creator:${parsed.data.creatorId}:activation:resume:${correlationId}`,
      },
    });
    logEvent("info", "creator.activation.resume_queued", {
      correlationId,
      organizationId: session.organizationId,
      creatorId: parsed.data.creatorId,
      workflowRunId: resumable.id,
      previousStatus: resumable.status,
    });
    return NextResponse.json(
      { status: "QUEUED", workflowRunId: resumable.id, eventIds: result.ids },
      { status: 202 },
    );
  } catch (error) {
    logEvent("error", "creator.activation.resume_failed", {
      correlationId,
      error: error instanceof Error ? error.message : "UNKNOWN",
    });
    if (error instanceof AuthorizationError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "WORKFLOW_RESUME_FAILED" }, { status: 500 });
  }
}
