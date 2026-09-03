import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { logEvent } from "@/lib/observability";
import { TaskError, taskPrioritySchema, updateTaskPriority } from "@/lib/tasks";

const bodySchema = z.object({
  status: z.enum(["IN_PROGRESS", "DONE"]),
  // PostgREST always serializes timestamptz with a numeric offset (+00:00),
  // never a bare Z, so the concurrency token round-tripped from a GET must be
  // accepted in that form or every live status change is refused as invalid
  // input before it ever reaches the database.
  updatedAt: z.string().datetime({ offset: true }),
});
const taskSchema = z.object({ id: z.string().uuid(), status: z.string(), updated_at: z.string() });

export async function PATCH(request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    const taskId = z
      .string()
      .uuid()
      .parse((await context.params).taskId);
    const raw: unknown = await request.json();

    /**
     * Re-triaging priority and moving a task through its status are different
     * authorizations, so they are checked separately rather than sharing one
     * gate. `task.complete` is held by contractors and editors — the people who
     * do the work — while changing what is urgent is a management decision, so
     * priority requires `task.assign` (super_admin and creator_success).
     */
    if (raw !== null && typeof raw === "object" && "priority" in raw) {
      const session = await requirePermission("task.assign");
      const body = taskPrioritySchema.safeParse(raw);
      if (!body.success) return NextResponse.json({ error: "INVALID_INPUT" }, { status: 400 });
      return NextResponse.json(await updateTaskPriority(session, taskId, body.data));
    }

    const session = await requirePermission("task.complete");
    const body = bodySchema.safeParse(raw);
    if (!body.success) return NextResponse.json({ error: "INVALID_INPUT" }, { status: 400 });
    const client = createSupabaseAdminClient();
    if (!client) return NextResponse.json({ error: "DATABASE_NOT_CONFIGURED" }, { status: 503 });
    const lookup = await client
      .from("tasks")
      .select("id,status,updated_at")
      .eq("id", taskId)
      .eq("organization_id", session.organizationId)
      .maybeSingle();
    const task = taskSchema.safeParse(lookup.data);
    if (lookup.error || !task.success)
      return NextResponse.json({ error: "TASK_NOT_FOUND" }, { status: 404 });
    if (task.data.updated_at !== body.data.updatedAt)
      return NextResponse.json({ error: "TASK_CHANGED_REFRESH_REQUIRED" }, { status: 409 });
    const valid =
      (task.data.status === "OPEN" && body.data.status === "IN_PROGRESS") ||
      (task.data.status === "IN_PROGRESS" && body.data.status === "DONE");
    if (!valid) return NextResponse.json({ error: "INVALID_TASK_TRANSITION" }, { status: 409 });
    const updatedAt = new Date().toISOString();
    const update = await client
      .from("tasks")
      .update({
        status: body.data.status,
        updated_at: updatedAt,
        completed_at: body.data.status === "DONE" ? updatedAt : null,
      })
      .eq("id", taskId)
      .eq("organization_id", session.organizationId)
      .eq("updated_at", body.data.updatedAt)
      .select("id")
      .maybeSingle();
    if (update.error || !update.data)
      return NextResponse.json({ error: "TASK_CHANGED_REFRESH_REQUIRED" }, { status: 409 });
    // Best-effort, same as every other write path (apps/web/src/lib/tasks.ts's
    // auditBestEffort): the status change above already committed, so a
    // failure writing the audit row must not turn into a 500 that tells the
    // caller nothing happened -- it did, and a caller that retries a "failed"
    // request would attempt an invalid transition against the new status.
    try {
      const audit = await client.from("audit_events").insert({
        organization_id: session.organizationId,
        actor_type: "user",
        actor_user_id: session.userId,
        action: "task.status.changed",
        resource_type: "task",
        resource_id: taskId,
        before_json: { status: task.data.status },
        after_json: { status: body.data.status },
        correlation_id: crypto.randomUUID(),
      });
      if (audit.error) throw new Error(audit.error.message);
    } catch (auditError) {
      logEvent("error", "task.status_audit_failed", {
        taskId,
        userId: session.userId,
        message: auditError instanceof Error ? auditError.message : String(auditError),
      });
    }
    return NextResponse.json({ id: taskId, status: body.data.status, updatedAt });
  } catch (error) {
    if (error instanceof AuthorizationError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof TaskError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof z.ZodError)
      return NextResponse.json({ error: "INVALID_TASK_ID" }, { status: 400 });
    return NextResponse.json({ error: "TASK_UPDATE_FAILED" }, { status: 500 });
  }
}
