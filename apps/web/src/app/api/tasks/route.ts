import { NextResponse } from "next/server";
import type { WorkDepartment, WorkPriority } from "@creatoros/domain";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { TaskError, createTask, taskCreateSchema } from "@/lib/tasks";

const DEFAULT_DEPARTMENT: WorkDepartment = "Operations";
const DEFAULT_PRIORITY: WorkPriority = "MEDIUM";

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
    const [result, creatorResult] = await Promise.all([
      client
        .from("tasks")
        .select(
          "id,creator_id,title,department,priority,status,owner_user_id,due_at,source_type,source_id,updated_at,creators(stage_name)",
        )
        .eq("organization_id", session.organizationId)
        .order("due_at", { ascending: true, nullsFirst: false })
        .limit(250),
      // The create form needs the creators a task may be attached to. Scoped to
      // the caller's organization and to creators still on the roster.
      client
        .from("creators")
        .select("id,stage_name")
        .eq("organization_id", session.organizationId)
        .is("archived_at", null)
        .order("stage_name"),
    ]);
    if (result.error) throw new Error(result.error.message);
    if (creatorResult.error) throw new Error(creatorResult.error.message);
    const taskRows = rowsSchema.parse(result.data ?? []);

    // Real names, not the literal string "Assigned user". A task list that
    // cannot say who owns a task is the same as an unowned task list.
    // Resolved before the mapping below uses it.
    const ownerIds = [
      ...new Set(
        taskRows.map((row) => row.owner_user_id).filter((id): id is string => typeof id === "string"),
      ),
    ];
    const ownerNames = new Map<string, string>();
    if (ownerIds.length > 0) {
      const owners = await client.from("users").select("id,display_name,email").in("id", ownerIds);
      if (owners.error) throw new Error(owners.error.message);
      for (const owner of z
        .array(
          z.object({
            id: z.string().uuid(),
            display_name: z.string().nullable(),
            email: z.string(),
          }),
        )
        .parse(owners.data ?? []))
        ownerNames.set(owner.id, owner.display_name ?? owner.email);
    }

    const tasks = taskRows.map((row) => ({
      id: row.id,
      creatorId: row.creator_id,
      creatorName: row.creators?.stage_name ?? "Foundry",
      title: row.title,
      // Canonical casing (WORK_DEPARTMENTS is "Operations", not "OPERATIONS")
      // and a value that actually exists in WORK_PRIORITIES -- "NORMAL" isn't
      // one of them, so a task with no priority set rendered a status the
      // rest of the app never produces and StatusBadge had no styling for.
      department: row.department ?? DEFAULT_DEPARTMENT,
      priority: row.priority ?? DEFAULT_PRIORITY,
      status: row.status,
      ownerUserId: row.owner_user_id,
      owner: row.owner_user_id ? (ownerNames.get(row.owner_user_id) ?? "Unknown user") : "Unassigned",
      dueAt: row.due_at ? new Date(row.due_at).toLocaleDateString() : "Unscheduled",
      sourceType: row.source_type ?? "MANUAL",
      sourceId: row.source_id,
      updatedAt: row.updated_at,
    }));
    const creators = z
      .array(z.object({ id: z.string().uuid(), stage_name: z.string() }))
      .parse(creatorResult.data ?? [])
      .map((row) => ({ id: row.id, name: row.stage_name }));
    // The create form needs someone to assign to. Active members only: a
    // deactivated colleague is not a valid owner.
    const memberships = await client
      .from("organization_memberships")
      .select("user_id")
      .eq("organization_id", session.organizationId)
      .eq("active", true);
    if (memberships.error) throw new Error(memberships.error.message);
    const memberIds = z
      .array(z.object({ user_id: z.string().uuid() }))
      .parse(memberships.data ?? [])
      .map((row) => row.user_id);
    const team: Array<{ id: string; name: string }> = [];
    if (memberIds.length > 0) {
      const people = await client.from("users").select("id,display_name,email").in("id", memberIds);
      if (people.error) throw new Error(people.error.message);
      for (const person of z
        .array(
          z.object({
            id: z.string().uuid(),
            display_name: z.string().nullable(),
            email: z.string(),
          }),
        )
        .parse(people.data ?? []))
        team.push({ id: person.id, name: person.display_name ?? person.email });
      team.sort((left, right) => left.name.localeCompare(right.name));
    }

    return NextResponse.json({ data: tasks, creators, team });
  } catch (error) {
    if (error instanceof AuthorizationError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "TASK_READ_FAILED" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const session = await requirePermission("task.create");
    const body = taskCreateSchema.safeParse(await request.json());
    if (!body.success) return NextResponse.json({ error: "INVALID_INPUT" }, { status: 400 });
    const task = await createTask(session, body.data);
    return NextResponse.json({ data: task }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthorizationError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof TaskError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "TASK_CREATE_FAILED" }, { status: 500 });
  }
}
