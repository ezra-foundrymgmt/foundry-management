import { afterEach, describe, expect, it } from "vitest";
import { config, isDeveloperMockMode } from "./proxy";

/**
 * The matcher decides which requests are authenticated. A mistake here ships an
 * unauthenticated route silently, so it is asserted rather than eyeballed.
 *
 * Next anchors matcher patterns, so they are tested anchored.
 */
const matcher = config.matcher[0] ?? "";
const pattern = new RegExp(`^${matcher}$`);
const proxyRuns = (path: string) => pattern.test(path);

describe("auth proxy matcher", () => {
  it("authenticates application pages and ordinary API routes", () => {
    for (const path of [
      "/",
      "/dashboard",
      "/creators",
      "/crm/prospects",
      "/api/tasks",
      "/api/onboarding",
      "/api/integrations/slack/install",
      "/api/workflows/resume",
    ])
      expect(proxyRuns(path), `${path} must be authenticated`).toBe(true);
  });

  it("exempts exactly the routes that authenticate by signature, plus public assets", () => {
    for (const path of [
      "/api/health",
      "/api/inngest",
      "/api/inngest/anything",
      "/api/slack/events",
      "/api/intake/google-form",
      "/manifest.webmanifest",
      "/sw.js",
      "/icons/192",
      "/favicon.ico",
    ])
      expect(proxyRuns(path), `${path} must be exempt`).toBe(false);
  });

  it("does not exempt look-alike routes that merely share a prefix", () => {
    // Regression: the exclusions were bare prefixes with no segment boundary, so
    // /api/slack-admin/keys and /api/healthz were exempt from authentication.
    // Any future route whose name starts with an exempt one would have shipped
    // unauthenticated.
    for (const path of [
      "/api/slack-admin/keys",
      "/api/slackbot/run",
      "/api/slacks",
      "/api/slack/admin",
      // The intake exemption is anchored with $, so no other route under
      // /api/intake inherits it.
      "/api/intake",
      "/api/intake/google-form/apply",
      "/api/intake/google-forms",
      "/api/intake-admin/export",
      "/api/healthz",
      "/api/health-internal",
      "/api/inngestx",
      "/icons-internal/secret",
    ])
      expect(proxyRuns(path), `${path} must be authenticated`).toBe(true);
  });
});

/**
 * Adversarial review: the gate read CREATOROS_INTEGRATION_MODE raw and defaulted
 * to "mock", which means "skip authentication". The middleware runtime resolves
 * its environment separately from the page and route functions, so a variable
 * that failed to arrive would have served every route with no session check.
 * An absent variable must mean enforce.
 */
describe("mock-mode detection", () => {
  const saved = { ...process.env };

  function withEnv(values: Record<string, string | undefined>) {
    for (const key of ["CREATOROS_INTEGRATION_MODE", "APP_ENV", "VERCEL_ENV"])
      delete process.env[key];
    for (const [key, value] of Object.entries(values))
      if (value !== undefined) process.env[key] = value;
    return isDeveloperMockMode();
  }

  afterEach(() => {
    process.env = { ...saved };
  });

  it("enforces authentication when the mode variable is absent", () => {
    expect(withEnv({})).toBe(false);
  });

  it("enforces authentication in any deployed environment, whatever the mode says", () => {
    expect(withEnv({ CREATOROS_INTEGRATION_MODE: "mock", VERCEL_ENV: "preview" })).toBe(false);
    expect(withEnv({ CREATOROS_INTEGRATION_MODE: "mock", VERCEL_ENV: "production" })).toBe(false);
    expect(withEnv({ CREATOROS_INTEGRATION_MODE: "mock", APP_ENV: "staging" })).toBe(false);
    expect(withEnv({ CREATOROS_INTEGRATION_MODE: "mock", APP_ENV: "production" })).toBe(false);
  });

  it("skips authentication only on a developer machine that asked for mock mode", () => {
    expect(withEnv({ CREATOROS_INTEGRATION_MODE: "mock" })).toBe(true);
    expect(withEnv({ CREATOROS_INTEGRATION_MODE: "mock", APP_ENV: "development" })).toBe(true);
    expect(withEnv({ CREATOROS_INTEGRATION_MODE: "live" })).toBe(false);
  });
});
