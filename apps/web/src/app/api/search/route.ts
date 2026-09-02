import { NextResponse } from "next/server";
import { creators, prospects, tasks } from "@creatoros/domain";
import { AuthorizationError, requirePermission } from "@/lib/auth";
export async function GET(request: Request) {
  try {
    await requirePermission("creator.read");
    const query = (new URL(request.url).searchParams.get("q") ?? "")
      .trim()
      .toLowerCase()
      .slice(0, 80);
    if (!query) return NextResponse.json({ data: [] });
    const values = [
      ...creators.map((item) => ({ type: "creator", id: item.id, label: item.stageName })),
      ...prospects.map((item) => ({ type: "prospect", id: item.id, label: item.stageName })),
      ...tasks.map((item) => ({ type: "task", id: item.id, label: item.title })),
    ];
    return NextResponse.json({
      data: values.filter((item) => item.label.toLowerCase().includes(query)).slice(0, 20),
    });
  } catch (error) {
    if (error instanceof AuthorizationError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "SEARCH_FAILED" }, { status: 500 });
  }
}
