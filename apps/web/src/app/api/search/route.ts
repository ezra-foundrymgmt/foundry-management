import { NextResponse } from "next/server";
import { creators, prospects, tasks } from "@creatoros/domain";
import { hasPermission } from "@creatoros/domain";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { isMockMode } from "@/lib/environment";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
export async function GET(request: Request) {
  try {
    const session = await requirePermission("creator.read");
    const query = (new URL(request.url).searchParams.get("q") ?? "")
      .trim()
      .toLowerCase()
      .slice(0, 80);
    if (!query) return NextResponse.json({ data: [] });
    // Adversarial review, confirmed: search was gated on creator.read alone and
    // then returned prospects and tasks unconditionally. A contractor — whose
    // whole grant is creator.read and task.complete, and who is refused
    // /crm/prospects and the prospects API — could walk the entire acquisition
    // pipeline by iterating the query string. Search is not a separate authority
    // from the pages it searches.
    const canSeeProspects = hasPermission(session.role, "prospect.read");
    let values = [
      ...creators.map((item) => ({ type: "creator", id: item.id, label: item.stageName })),
      ...(canSeeProspects
        ? prospects.map((item) => ({ type: "prospect", id: item.id, label: item.stageName }))
        : []),
      ...tasks.map((item) => ({ type: "task", id: item.id, label: item.title })),
    ];
    if (!isMockMode()) {
      const client = createSupabaseAdminClient();
      if (!client) return NextResponse.json({ error: "DATABASE_NOT_CONFIGURED" }, { status: 503 });
      const pattern = `%${query.replace(/[%_]/g, "")}%`;
      const [creatorRows, prospectRows, taskRows] = await Promise.all([
        client
          .from("creators")
          .select("id,stage_name")
          .eq("organization_id", session.organizationId)
          .ilike("stage_name", pattern)
          .limit(8),
        canSeeProspects
          ? client
              .from("prospects")
              .select("id,stage_name")
              .eq("organization_id", session.organizationId)
              .ilike("stage_name", pattern)
              .limit(8)
          : Promise.resolve({ data: [], error: null }),
        client
          .from("tasks")
          .select("id,title")
          .eq("organization_id", session.organizationId)
          .ilike("title", pattern)
          .limit(8),
      ]);
      if (creatorRows.error || prospectRows.error || taskRows.error)
        throw new Error("SEARCH_DATABASE_FAILED");
      values = [
        ...(creatorRows.data ?? []).map((item) => ({
          type: "creator",
          id: String(item.id),
          label: String(item.stage_name),
        })),
        ...(prospectRows.data ?? []).map((item) => ({
          type: "prospect",
          id: String(item.id),
          label: String(item.stage_name),
        })),
        ...(taskRows.data ?? []).map((item) => ({
          type: "task",
          id: String(item.id),
          label: String(item.title),
        })),
      ];
    }
    return NextResponse.json({
      data: values.filter((item) => item.label.toLowerCase().includes(query)).slice(0, 20),
    });
  } catch (error) {
    if (error instanceof AuthorizationError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "SEARCH_FAILED" }, { status: 500 });
  }
}
