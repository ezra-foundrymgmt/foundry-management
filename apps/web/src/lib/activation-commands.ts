import "server-only";
import { z } from "zod";
import type { AppSession } from "@/lib/auth";

/** Who is asking and on whose behalf. Narrow so the Foundry agent, which runs
 * without the caller's email, can call exactly these. */
type Actor = Pick<AppSession, "userId" | "organizationId">;
import { isMockMode } from "@/lib/environment";
import { inngest } from "@/lib/inngest";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { logEvent } from "@/lib/observability";

/**
 * The deterministic way to start or resume a creator activation.
 *
 * Both the HTTP routes and the Foundry agent call these. The agent gets no
 * separate path into the workflow engine: whatever the model asks for ends up
 * running the same tenant check, the same idempotency key and the same event as
 * a founder clicking the button. A second implementation behind the agent would
 * be a second set of rules for who may activate whom.
 */
export interface ActivationQueued {
  status: "QUEUED";
  idempotencyKey: string;
  eventIds: string[];
}

export interface ResumeQueued {
  status: "QUEUED";
  workflowRunId: string;
  eventIds: string[];
}

function admin() {
  const client = createSupabaseAdminClient();
  if (!client) throw new Error("DATABASE_NOT_CONFIGURED");
  return client;
}

/**
 * Queues an activation for a creator in the caller's organization.
 *
 * The idempotency key is derived from the creator, so repeating the request —
 * a double click, a retried Slack message, a model that calls the tool twice —
 * does not queue a second activation.
 */
export async function startCreatorActivation(
  session: Actor,
  input: { creatorId: string; correlationId?: string },
): Promise<ActivationQueued> {
  if (isMockMode()) throw new Error("ACTIVATION_REQUIRES_LIVE_MODE");
  const client = admin();

  // Ownership is proven from the session's organization, never from the input.
  const creator = await client
    .from("creators")
    .select("id")
    .eq("organization_id", session.organizationId)
    .eq("id", input.creatorId)
    .maybeSingle();
  if (creator.error) throw new Error(`CREATOR_LOOKUP_FAILED: ${creator.error.message}`);
  const found = z.object({ id: z.string().uuid() }).safeParse(creator.data);
  if (!found.success) throw new Error("CREATOR_NOT_FOUND");

  const idempotencyKey = `creator:${found.data.id}:activation:v1`;
  const result = await inngest.send({
    id: idempotencyKey,
    name: "creator.activation.requested",
    data: {
      organizationId: session.organizationId,
      creatorId: found.data.id,
      actorUserId: session.userId,
      idempotencyKey,
    },
  });
  logEvent("info", "creator.activation.queued", {
    correlationId: input.correlationId,
    organizationId: session.organizationId,
    creatorId: found.data.id,
    actorUserId: session.userId,
  });
  return { status: "QUEUED", idempotencyKey, eventIds: result.ids };
}

/**
 * Resumes an activation parked in WAITING_EXTERNAL or repaired after a failure.
 *
 * The resume event carries its own idempotency key. Reusing the original
 * activation key would make Inngest deduplicate the resume against the initial
 * request and silently drop it, so a run could never be resumed twice. Safety
 * against concurrent resumes comes from the database instead:
 * workflow_runs_one_active_creator_definition_uidx permits only one non-terminal
 * run per creator, and provisioned_resources is keyed per resource.
 */
export async function resumeCreatorActivation(
  session: Actor,
  input: { creatorId: string; correlationId: string },
): Promise<ResumeQueued> {
  if (isMockMode()) throw new Error("RESUME_REQUIRES_LIVE_MODE");
  const client = admin();

  const run = await client
    .from("workflow_runs")
    .select("id,status")
    .eq("organization_id", session.organizationId)
    .eq("creator_id", input.creatorId)
    .not("status", "in", "(SUCCEEDED,CANCELLED)")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (run.error) throw new Error(`WORKFLOW_RUN_LOOKUP_FAILED: ${run.error.message}`);
  const resumable = z.object({ id: z.string().uuid(), status: z.string() }).safeParse(run.data);
  if (!resumable.success) throw new Error("NO_RESUMABLE_RUN");

  const result = await inngest.send({
    id: `creator:${input.creatorId}:activation:resume:${resumable.data.id}:${input.correlationId}`,
    name: "creator.activation.resume",
    data: {
      organizationId: session.organizationId,
      creatorId: input.creatorId,
      actorUserId: session.userId,
      idempotencyKey: `creator:${input.creatorId}:activation:resume:${input.correlationId}`,
    },
  });
  logEvent("info", "creator.activation.resume_queued", {
    correlationId: input.correlationId,
    organizationId: session.organizationId,
    creatorId: input.creatorId,
    workflowRunId: resumable.data.id,
    previousStatus: resumable.data.status,
  });
  return { status: "QUEUED", workflowRunId: resumable.data.id, eventIds: result.ids };
}
