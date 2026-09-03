import { describe, expect, it } from "vitest";
import { config } from "./proxy";

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
      "/api/healthz",
      "/api/health-internal",
      "/api/inngestx",
      "/icons-internal/secret",
    ])
      expect(proxyRuns(path), `${path} must be authenticated`).toBe(true);
  });
});
