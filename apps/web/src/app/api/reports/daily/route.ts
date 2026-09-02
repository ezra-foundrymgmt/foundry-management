import { NextResponse } from "next/server";
import { reports } from "@creatoros/domain";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { isMockMode } from "@/lib/environment";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
export async function GET(request: Request) {
  try {
    const session = await requirePermission("analytics.read");
    const creatorId = new URL(request.url).searchParams.get("creator");
    if (!isMockMode()) {
      const client = createSupabaseAdminClient();
      if (!client) return NextResponse.json({ error: "DATABASE_NOT_CONFIGURED" }, { status: 503 });
      let query = client
        .from("daily_creator_reports")
        .select(
          "id,creator_id,report_date,status,health_status,summary,primary_bottleneck,priority,metrics_json,anomalies_json,recommendations_json,data_quality_json,provider,generated_at,creators(stage_name)",
        )
        .eq("organization_id", session.organizationId)
        .order("report_date", { ascending: false })
        .limit(100);
      if (creatorId) query = query.eq("creator_id", creatorId);
      const result = await query;
      if (result.error) throw new Error(result.error.message);
      return NextResponse.json({
        data: creatorId ? (result.data?.[0] ?? null) : (result.data ?? []),
        provider: "DATABASE",
      });
    }
    const result = creatorId ? reports.find((item) => item.creatorId === creatorId) : reports;
    return NextResponse.json({ data: result ?? null, provider: "RULES" });
  } catch (error) {
    if (error instanceof AuthorizationError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "REPORT_READ_FAILED" }, { status: 500 });
  }
}
