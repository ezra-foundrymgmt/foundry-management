import "server-only";
import { z } from "zod";
import { WORK_DEPARTMENTS, WORK_PRIORITIES } from "@creatoros/domain";
import type { AppSession } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { appendAudit } from "@/lib/audit";
import { logEvent } from "@/lib/observability";

export const taskCreateSchema = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().max(4000).optional(),
  department: z.enum(WORK_DEPARTMENTS),
  priority: z.enum(WORK_PRIORITIES),
  creatorId: z.string().uuid().nullable().optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
});

export const taskPrioritySchema = z.object({
  priority: z.enum(WORK_PRIORITIES),
  // PostgREST always serializes timestamptz with a numeric offset (+00:00),
  // never a bare Z, so the token round-tripped from a GET must be accepted in
  // that form.
  updatedAt: z.string().datetime({ offset: true }),
});

/** A reason the caller is allowed to see. Routes return `message` verbatim. */
export class TaskError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Never let a driver message reach the caller. The reason stays in the server
 * log, where it is useful; the caller gets a code that says what happened
 * without naming internal tables, columns or constraints.
 */
function databaseFailure(operation: string, error: { message: string }): TaskError {
  logEvent("error", "task.database_failed", { operation, message: error.message });
  return new TaskError("TASK_DATABASE_FAILED", 500);
}

function admin() {
  const client = createSupabaseAdminClient();
  if (!client) throw new TaskError("DATABASE_NOT_CONFIGURED", 503);
  return client;
}

/**
 * Appends an audit entry for a mutation that has already committed.
 *
 * appendAudit is a second, independent write after the one that changed the
 * row. Letting its failure propagate would make the caller see a 500 and
 * conclude nothing happened, when the task was in fact already
 * created/changed — worse than the audit gap itself, since the caller could
 * retry a write that already applied. So a failure here is logged loudly
 * instead — it is the one way this change could go unattributed — and the
 * caller still gets the success it actually got.
 */
async function auditBestEffort(
  session: AppSession,
  action: string,
  resourceId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await appendAudit(session, action, "task", resourceId, metadata);
  } catch (auditError) {
    logEvent("error", "task.audit_failed", {
      action,
      resourceId,
      userId: session.userId,
      message: auditError instanceof Error ? auditError.message : String(auditError),
    });
  }
}

/**
 * Creates a task directly, rather than only as a by-product of a report.
 *
 * Before this existed the sole way to get a row into `tasks` was
 * POST /api/reports/[reportId]/tasks, so any work that did not originate in a
 * generated recommendation had nowhere to live and the Tasks page shipped a
 * permanently disabled "Create task" button.
 *
 * A creator id is optional — plenty of Foundry work is not creator-scoped — but
 * when supplied it is proven to belong to the caller's organization first, so a
 * creator id from another tenant is refused rather than silently attached.
 */
export async function createTask(session: AppSession, input: z.infer<typeof taskCreateSchema>) {
  const client = admin();

  if (input.creatorId) {
    const owner = await client
      .from("creators")
      .select("id")
      .eq("organization_id", session.organizationId)
      .eq("id", input.creatorId)
      .maybeSingle();
    if (owner.error) throw databaseFailure("read-creator", owner.error);
    if (!owner.data) throw new TaskError("CREATOR_NOT_FOUND", 404);
  }

  const { data, error } = await client
    .from("tasks")
    .insert({
      organization_id: session.organizationId,
      creator_id: input.creatorId ?? null,
      title: input.title,
      description: input.description ?? null,
      department: input.department,
      priority: input.priority,
      status: "OPEN",
      owner_user_id: input.ownerUserId ?? null,
      // Who asked for the work, which is not the same as who owns it.
      requested_by: session.userId,
      source_type: "MANUAL",
      due_at: input.dueAt ?? null,
    })
    .select("id,title,priority,status,department,creator_id,due_at,updated_at")
    .single();
  if (error) throw databaseFailure("write", error);

  const created = data as { id: string; title: string; priority: string };
  await auditBestEffort(session, "task.created", created.id, {
    title: created.title,
    priority: created.priority,
    department: input.department,
    creatorId: input.creatorId ?? null,
  });
  return data;
}

/**
 * Changes a task's priority.
 *
 * `tasks.priority` was writable only by the report route, so a task's urgency
 * could never be re-triaged after creation. Guarded by the same optimistic
 * concurrency check the status transition uses: two people re-prioritising the
 * same task from stale views must not have the later write silently win.
 */
export async function updateTaskPriority(
  session: AppSession,
  taskId: string,
  input: z.infer<typeof taskPrioritySchema>,
) {
  const client = admin();
  const current = await client
    .from("tasks")
    .select("id,priority,updated_at")
    .eq("organization_id", session.organizationId)
    .eq("id", taskId)
    .maybeSingle();
  if (current.error) throw databaseFailure("read-current", current.error);
  if (!current.data) throw new TaskError("TASK_NOT_FOUND", 404);
  const before = current.data as { priority: string | null; updated_at: string };
  if (before.updated_at !== input.updatedAt)
    throw new TaskError("TASK_CHANGED_REFRESH_REQUIRED", 409);

  const updatedAt = new Date().toISOString();
  const { data, error } = await client
    .from("tasks")
    .update({ priority: input.priority, updated_at: updatedAt })
    .eq("organization_id", session.organizationId)
    .eq("id", taskId)
    .eq("updated_at", input.updatedAt)
    .select("id,priority")
    .maybeSingle();
  if (error) throw databaseFailure("write", error);
  if (!data) throw new TaskError("TASK_CHANGED_REFRESH_REQUIRED", 409);

  await auditBestEffort(session, "task.priority.changed", taskId, {
    before: before.priority,
    after: input.priority,
  });
  return { id: taskId, priority: input.priority, updatedAt };
}
