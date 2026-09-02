import { describe, expect, it } from "vitest";
import {
  assertSameOrganization,
  authorizeRole,
  selectSingleActiveMembership,
} from "./authorization";

const orgA = "00000000-0000-4000-8000-000000000001";
const orgB = "00000000-0000-4000-8000-000000000002";

describe("adversarial authorization boundaries", () => {
  it("rejects a cross-organization resource before mutation", () => {
    expect(() => assertSameOrganization(orgA, orgB)).toThrow("RESOURCE_ORGANIZATION_MISMATCH");
  });
  it("does not accept inactive, malformed, or ambiguous memberships", () => {
    expect(
      selectSingleActiveMembership([{ organization_id: orgA, role: "super_admin", active: false }]),
    ).toBeNull();
    expect(
      selectSingleActiveMembership([
        { organization_id: orgA, role: "viewer", active: true },
        { organization_id: orgB, role: "viewer", active: true },
      ]),
    ).toBeNull();
  });
  it("denies escalation from a read-only role", () => {
    expect(() => authorizeRole("viewer", "integration.manage")).toThrow("PERMISSION_DENIED");
  });
});
