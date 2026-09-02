import { getEnvironment, validateRuntimeEnvironment } from "@/lib/environment";
import { getCorrelationId, jsonResponse } from "@/lib/observability";

export function GET(request: Request) {
  const environment = getEnvironment();
  const errors = validateRuntimeEnvironment(environment);
  return jsonResponse(
    {
      status: errors.length ? "degraded" : "ok",
      service: "creatoros",
      environment: environment.APP_ENV,
      mode: environment.CREATOROS_INTEGRATION_MODE,
      checks: {
        configuration: errors.length ? "failed" : "ok",
        supabase: environment.NEXT_PUBLIC_SUPABASE_URL ? "configured" : "mock",
        inngest: environment.INNGEST_SIGNING_KEY ? "configured" : "mock",
      },
    },
    { status: errors.length ? 503 : 200 },
    getCorrelationId(request),
  );
}
