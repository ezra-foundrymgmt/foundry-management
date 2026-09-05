import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { IntakeError, listIntakeSubmissions } from "@/lib/creator-intake";
import { captureException, getCorrelationId } from "@/lib/observability";

export async function GET(request: Request) {
  const correlationId = getCorrelationId(request);
  try {
    const session = await requirePermission("creator.read");
    return NextResponse.json({ data: await listIntakeSubmissions(session) });
  } catch (error) {
    if (error instanceof AuthorizationError || error instanceof IntakeError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    captureException(error, { correlationId, event: "creator.intake.list_failed" });
    return NextResponse.json({ error: "INTAKE_READ_FAILED" }, { status: 500 });
  }
}
