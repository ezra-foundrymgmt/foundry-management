import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@creatoros/domain";

const getSession = vi.fn();
vi.mock("@/lib/auth", () => ({ getSession }));

const { authorizePage } = await import("./page-access");

function sessionAs(role: Role) {
  return {
    userId: "11111111-1111-4111-8111-111111111111",
    organizationId: "22222222-2222-4222-8222-222222222222",
    role,
    email: `${role}@foundry.test`,
  };
}

beforeEach(() => {
  getSession.mockReset();
});

describe("page-level authorization", () => {
  it("denies an anonymous visitor before any data is read", async () => {
    getSession.mockResolvedValue(null);
    expect(await authorizePage("creator.read")).toEqual({
      allowed: false,
      reason: "AUTHENTICATION_REQUIRED",
    });
  });

  it("treats a session lookup failure as unauthenticated rather than allowed", async () => {
    getSession.mockRejectedValue(new Error("LIVE_DATA_UNAVAILABLE"));
    expect(await authorizePage("creator.read")).toEqual({
      allowed: false,
      reason: "AUTHENTICATION_REQUIRED",
    });
  });

  it("denies the audit trail to every role except super_admin", async () => {
    const denied: Role[] = [
      "growth",
      "creator_success",
      "fan_ops",
      "editor",
      "analyst",
      "finance",
      "contractor",
      "viewer",
    ];
    for (const role of denied) {
      getSession.mockResolvedValue(sessionAs(role));
      expect(await authorizePage("audit.read")).toEqual({
        allowed: false,
        reason: "PERMISSION_DENIED",
      });
    }
    getSession.mockResolvedValue(sessionAs("super_admin"));
    expect((await authorizePage("audit.read")).allowed).toBe(true);
  });

  it("denies unit economics to roles without finance.read", async () => {
    for (const role of ["growth", "viewer", "editor", "contractor"] as Role[]) {
      getSession.mockResolvedValue(sessionAs(role));
      expect(await authorizePage("finance.read")).toEqual({
        allowed: false,
        reason: "PERMISSION_DENIED",
      });
    }
    for (const role of ["finance", "super_admin"] as Role[]) {
      getSession.mockResolvedValue(sessionAs(role));
      expect((await authorizePage("finance.read")).allowed).toBe(true);
    }
  });

  it("allows a viewer the read pages their role does grant", async () => {
    getSession.mockResolvedValue(sessionAs("viewer"));
    expect((await authorizePage("creator.read")).allowed).toBe(true);
    expect((await authorizePage("prospect.read")).allowed).toBe(true);
  });

  it("returns the caller's own session so pages cannot substitute another tenant", async () => {
    const session = sessionAs("super_admin");
    getSession.mockResolvedValue(session);
    const access = await authorizePage("creator.read");
    expect(access.allowed && access.session.organizationId).toBe(session.organizationId);
  });
});
