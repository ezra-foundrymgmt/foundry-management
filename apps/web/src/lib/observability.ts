import "server-only";

const secretKeyPattern = /(authorization|token|secret|password|cookie|key|dsn)/i;

export function getCorrelationId(request?: Request) {
  const supplied = request?.headers.get("x-correlation-id");
  return supplied && /^[a-zA-Z0-9-]{8,80}$/.test(supplied) ? supplied : crypto.randomUUID();
}

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      secretKeyPattern.test(key) ? "[REDACTED]" : value,
    ]),
  );
}

export function logEvent(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
) {
  console[level](
    JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...redact(fields) }),
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

/**
 * A Sentry DSN, split into what the ingest request actually needs.
 *
 * Parsed rather than pattern-matched so a malformed DSN is detected at the point
 * of configuration instead of silently producing requests that go nowhere.
 */
export interface ParsedDsn {
  endpoint: string;
  publicKey: string;
  projectId: string;
}

export function parseSentryDsn(dsn: string): ParsedDsn | null {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\//, "");
    if (!url.username || !projectId || !/^\d+$/.test(projectId)) return null;
    return {
      endpoint: `${url.protocol}//${url.host}/api/${projectId}/store/`,
      publicKey: url.username,
      projectId,
    };
  } catch {
    return null;
  }
}

export interface ErrorContext {
  correlationId?: string;
  organizationId?: string;
  userId?: string;
  route?: string;
  [key: string]: unknown;
}

/**
 * Records a server exception.
 *
 * Structured logging always happens; external reporting is strictly optional and
 * best-effort. A missing or malformed `SENTRY_DSN` must never turn a handled
 * error into an unhandled one, and neither must the reporting request failing —
 * so this never throws and never awaits the network on the request path.
 */
export function captureException(error: unknown, context: ErrorContext = {}): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  logEvent("error", "server.exception", { ...context, error: message });

  const dsn = process.env["SENTRY_DSN"];
  if (!dsn) return;
  const parsed = parseSentryDsn(dsn);
  if (!parsed) {
    // Configured but wrong is worth saying out loud once, at the point of use.
    logEvent("warn", "observability.invalid_sentry_dsn", {});
    return;
  }

  const payload = {
    event_id: crypto.randomUUID().replaceAll("-", ""),
    timestamp: new Date().toISOString(),
    platform: "node",
    level: "error",
    logger: "creatoros",
    environment: process.env["APP_ENV"] ?? "development",
    exception: {
      values: [
        {
          type: error instanceof Error ? error.name : "Error",
          value: message,
          stacktrace: undefined,
        },
      ],
    },
    // Redacted the same way logs are: this leaves the server.
    extra: redact(context),
    ...(stack ? { extra_stack: stack.slice(0, 4000) } : {}),
  };

  void fetch(parsed.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${parsed.publicKey}, sentry_client=creatoros/1.0`,
    },
    body: JSON.stringify(payload),
  }).catch(() => {
    // Reporting failing must not affect the request that was already handled.
  });
}
