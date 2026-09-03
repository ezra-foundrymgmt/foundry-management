import { NextResponse } from "next/server";
import { z } from "zod";
import { WORK_DEPARTMENTS, WORK_PRIORITIES } from "@creatoros/domain";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const reportSchema = z.object({
  id: z.string().uuid(),
  creator_id: z.string().uuid(),
  recommendations_json: z.array(
    z.object({
      id: z.string().optional(),
      // Matches Recommendation's own type in @creatoros/domain: a report-sourced
      // task must land on the same priority/department ladder a hand-created one
      // does, or the Tasks page's priority control cannot represent it.
      department: z.enum(WORK_DEPARTMENTS),
      priority: z.enum(WORK_PRIORITIES),
      action: z.string().min(1).max(500),
    }),
  ),
});

export async function POST(_request: Request, context: { params: Promise<{ reportId: string }> }) {
  try {
    const session = await requirePermission("task.create");
    const reportId = z
      .string()
      .uuid()
      .parse((await context.params).reportId);
    const client = createSupabaseAdminClient();
    if (!client) return NextResponse.json({ error: "DATABASE_NOT_CONFIGURED" }, { status: 503 });
    const result = await client
      .from("daily_creator_reports")
      .select("id,creator_id,recommendations_json")
      .eq("id", reportId)
      .eq("organization_id", session.organizationId)
      .maybeSingle();
    const report = reportSchema.safeParse(result.data);
    if (result.error || !report.success)
      return NextResponse.json({ error: "REPORT_NOT_FOUND" }, { status: 404 });
    const dueAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const writes = report.data.recommendations_json.map((recommendation, index) => ({
      organization_id: session.organizationId,
      creator_id: report.data.creator_id,
      title: recommendation.action,
      department: recommendation.department,
      priority: recommendation.priority,
      status: "OPEN",
      requested_by: session.userId,
      source_type: "REPORT",
      source_id: reportId,
      due_at: dueAt,
      idempotency_key: `report:${reportId}:recommendation:${recommendation.id ?? index}`,
    }));
    if (writes.length) {
      const save = await client
        .from("tasks")
        .upsert(writes, { onConflict: "organization_id,idempotency_key", ignoreDuplicates: true });
      if (save.error) throw new Error(save.error.message);
    }
    const audit = await client.from("audit_events").insert({
      organization_id: session.organizationId,
      actor_type: "user",
      actor_user_id: session.userId,
      action: "report.recommendation_tasks.created",
      resource_type: "daily_creator_report",
      resource_id: reportId,
      after_json: { count: writes.length },
      correlation_id: crypto.randomUUID(),
    });
    if (audit.error) throw new Error(audit.error.message);
    return NextResponse.json({ createdOrExisting: writes.length });
  } catch (error) {
    if (error instanceof AuthorizationError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof z.ZodError)
      return NextResponse.json({ error: "INVALID_REPORT_ID" }, { status: 400 });
    return NextResponse.json({ error: "TASK_CREATION_FAILED" }, { status: 500 });
  }
}
