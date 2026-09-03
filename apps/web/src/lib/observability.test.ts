import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureException, getCorrelationId, logEvent, parseSentryDsn } from "./observability";

const originalDsn = process.env["SENTRY_DSN"];

beforeEach(() => {
  vi.restoreAllMocks();
  delete process.env["SENTRY_DSN"];
});

afterEach(() => {
  if (originalDsn === undefined) delete process.env["SENTRY_DSN"];
  else process.env["SENTRY_DSN"] = originalDsn;
});

describe("correlation ids", () => {
  it("accepts a well-formed supplied id so a request can be traced end to end", () => {
    const request = new Request("https://example.test", {
      headers: { "x-correlation-id": "abc-123-def-456" },
    });
    expect(getCorrelationId(request)).toBe("abc-123-def-456");
  });

  it("ignores a malformed or injected id and mints its own", () => {
    for (const supplied of ["short", "has spaces", "<script>", "x".repeat(200)]) {
      const request = new Request("https://example.test", {
        headers: { "x-correlation-id": supplied },
      });
      expect(getCorrelationId(request)).not.toBe(supplied);
    }
  });
});

describe("log redaction", () => {
  it("redacts anything whose key looks like a credential", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logEvent("error", "test.event", {
      authorization: "Bearer abc",
      accessToken: "xoxb-secret",
      clientSecret: "shh",
      password: "hunter2",
      sessionCookie: "sid=1",
      encryptionKey: "k",
      sentryDsn: "https://x@y/1",
      creatorId: "visible",
    });
    const payload = String(spy.mock.calls[0]?.[0]);
    for (const secret of ["Bearer abc", "xoxb-secret", "shh", "hunter2", "sid=1", "https://x@y/1"])
      expect(payload).not.toContain(secret);
    // Non-sensitive context still has to survive or the log is useless.
    expect(payload).toContain("visible");
  });
});

describe("Sentry DSN parsing", () => {
  it("derives the ingest endpoint and key from a valid DSN", () => {
    expect(parseSentryDsn("https://abc123@o1.ingest.sentry.io/456")).toEqual({
      endpoint: "https://o1.ingest.sentry.io/api/456/store/",
      publicKey: "abc123",
      projectId: "456",
    });
  });

  it("rejects a malformed DSN instead of building a request that goes nowhere", () => {
    for (const dsn of [
      "not-a-url",
      "https://o1.ingest.sentry.io/456",
      "https://abc123@o1.ingest.sentry.io/",
      "https://abc123@o1.ingest.sentry.io/not-numeric",
      "",
    ])
      expect(parseSentryDsn(dsn)).toBeNull();
  });
});

describe("exception capture", () => {
  it("logs the exception and does not call out when no DSN is configured", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    captureException(new Error("boom"), { correlationId: "corr-1", route: "/api/tasks" });
    expect(String(log.mock.calls[0]?.[0])).toContain("boom");
    // Absent credentials must never make a handled error into a failure.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("warns rather than throwing when the DSN is configured but malformed", () => {
    process.env["SENTRY_DSN"] = "nonsense";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(() => captureException(new Error("boom"))).not.toThrow();
    expect(String(warn.mock.calls[0]?.[0])).toContain("invalid_sentry_dsn");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports to Sentry when a valid DSN is configured, redacting context", () => {
    process.env["SENTRY_DSN"] = "https://abc123@o1.ingest.sentry.io/456";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(new Response("{}")));

    captureException(new Error("boom"), { correlationId: "corr-1", accessToken: "xoxb-secret" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0];
    expect(call?.[0]).toBe("https://o1.ingest.sentry.io/api/456/store/");
    const body = typeof call?.[1]?.body === "string" ? call[1].body : "";
    expect(body).toContain("boom");
    // Context leaves the server, so it is redacted exactly like a log line.
    expect(body).not.toContain("xoxb-secret");
  });

  it("does not reject when the reporting request itself fails", async () => {
    process.env["SENTRY_DSN"] = "https://abc123@o1.ingest.sentry.io/456";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.reject(new Error("network")));
    expect(() => captureException(new Error("boom"))).not.toThrow();
    // Let the rejected promise settle; an unhandled rejection would fail the run.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
