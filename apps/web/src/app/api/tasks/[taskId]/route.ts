import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const bodySchema = z.object({
  status: z.enum(["IN_PROGRESS", "DONE"]),
  updatedAt: z.string().datetime(),
});
const taskSchema = z.object({ id: z.string().uuid(), status: z.string(), updated_at: z.string() });

export async function PATCH(request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    const session = await requirePermission("task.complete");
    const taskId = z
      .string()
      .uuid()
      .parse((await context.params).taskId);
    const body = bodySchema.safeParse(await request.json());
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
    return NextResponse.json({ id: taskId, status: body.data.status, updatedAt });
  } catch (error) {
    if (error instanceof AuthorizationError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof z.ZodError)
      return NextResponse.json({ error: "INVALID_TASK_ID" }, { status: 400 });
    return NextResponse.json({ error: "TASK_UPDATE_FAILED" }, { status: 500 });
  }
}
