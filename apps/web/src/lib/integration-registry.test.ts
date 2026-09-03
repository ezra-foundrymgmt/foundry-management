import { describe, expect, it } from "vitest";
import { isTokenUsable } from "./integration-registry";

/**
 * Drill E: a revoked Slack token must mark the integration as needing
 * reauthorization, while a merely degraded one must stay usable so the
 * connection can recover on its own.
 */
describe("Drill E — integration token usability", () => {
  it("uses a healthy connection", () => {
    expect(isTokenUsable({ status: "CONNECTED", needs_reauthorization: false })).toBe(true);
  });

  it("keeps using a degraded connection so it can recover", () => {
    // Regression: requiring CONNECTED deadlocked the integration. One failed
    // health check set DEGRADED, DEGRADED made the token unreadable, and the
    // health check needs the token — so nothing could ever clear it.
    expect(isTokenUsable({ status: "DEGRADED", needs_reauthorization: false })).toBe(true);
    expect(isTokenUsable({ status: "DEGRADED" })).toBe(true);
    expect(isTokenUsable({ status: "DEGRADED", needs_reauthorization: null })).toBe(true);
  });

  it("refuses a connection the provider has actually revoked", () => {
    // needs_reauthorization is set when Slack or Notion answers invalid_auth or
    // token_revoked. That is genuine revocation, not a transient outage.
    expect(isTokenUsable({ status: "DEGRADED", needs_reauthorization: true })).toBe(false);
    expect(isTokenUsable({ status: "CONNECTED", needs_reauthorization: true })).toBe(false);
  });

  it("refuses a connection that was never established or was disconnected", () => {
    for (const status of ["NOT_CONFIGURED", "CONFIGURED", "CONNECTING", "DISCONNECTED", "ERROR"])
      expect(isTokenUsable({ status, needs_reauthorization: false })).toBe(false);
  });
});
