import { NextResponse } from "next/server";
import { reports } from "@creatoros/domain";
import { AuthorizationError, requirePermission } from "@/lib/auth";
export async function GET(request: Request) {
  try {
    await requirePermission("analytics.read");
    const creatorId = new URL(request.url).searchParams.get("creator");
    const result = creatorId ? reports.find((item) => item.creatorId === creatorId) : reports;
    return NextResponse.json({ data: result ?? null, provider: "RULES" });
  } catch (error) {
    if (error instanceof AuthorizationError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "REPORT_READ_FAILED" }, { status: 500 });
  }
}
