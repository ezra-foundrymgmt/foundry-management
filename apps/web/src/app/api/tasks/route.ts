import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const rowsSchema = z.array(
  z.object({
    id: z.string().uuid(),
    creator_id: z.string().uuid().nullable(),
    title: z.string(),
    department: z.string().nullable(),
    priority: z.string().nullable(),
    status: z.string(),
    owner_user_id: z.string().uuid().nullable(),
    due_at: z.string().nullable(),
    source_type: z.string().nullable(),
    source_id: z.string().uuid().nullable(),
    updated_at: z.string(),
    creators: z.object({ stage_name: z.string() }).nullable().optional(),
  }),
);

export async function GET() {
  try {
    const session = await requirePermission("creator.read");
    const client = createSupabaseAdminClient();
    if (!client) return NextResponse.json({ error: "DATABASE_NOT_CONFIGURED" }, { status: 503 });
    const result = await client
      .from("tasks")
      .select(
        "id,creator_id,title,department,priority,status,owner_user_id,due_at,source_type,source_id,updated_at,creators(stage_name)",
      )
      .eq("organization_id", session.organizationId)
      .order("due_at", { ascending: true, nullsFirst: false })
      .limit(250);
    if (result.error) throw new Error(result.error.message);
    const tasks = rowsSchema.parse(result.data ?? []).map((row) => ({
      id: row.id,
      creatorId: row.creator_id,
      creatorName: row.creators?.stage_name ?? "Foundry",
      title: row.title,
      department: row.department ?? "OPERATIONS",
      priority: row.priority ?? "NORMAL",
      status: row.status,
      owner: row.owner_user_id ? "Assigned user" : "Unassigned",
      dueAt: row.due_at ? new Date(row.due_at).toLocaleDateString() : "Unscheduled",
      sourceType: row.source_type ?? "MANUAL",
      sourceId: row.source_id,
      updatedAt: row.updated_at,
    }));
    return NextResponse.json({ data: tasks });
  } catch (error) {
    if (error instanceof AuthorizationError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "TASK_READ_FAILED" }, { status: 500 });
  }
}
