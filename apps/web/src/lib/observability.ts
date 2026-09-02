import "server-only";

const secretKeyPattern = /(authorization|token|secret|password|cookie|key)/i;

export function getCorrelationId(request?: Request) {
  const supplied = request?.headers.get("x-correlation-id");
  return supplied && /^[a-zA-Z0-9-]{8,80}$/.test(supplied) ? supplied : crypto.randomUUID();
}

export function logEvent(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
) {
  const safeFields = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      secretKeyPattern.test(key) ? "[REDACTED]" : value,
    ]),
  );
  console[level](
    JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...safeFields }),
  );
}

export function jsonResponse(
  body: unknown,
  init: ResponseInit = {},
  correlationId = crypto.randomUUID(),
) {
  const headers = new Headers(init.headers);
  headers.set("x-correlation-id", correlationId);
  headers.set("cache-control", "no-store");
  return Response.json(body, { ...init, headers });
}
