import { describe, expect, it } from "vitest";
import {
  assertProjectableFields,
  ProjectionBoundaryError,
  PROJECTABLE_CREATOR_FIELDS,
} from "./projection";

describe("creator-facing projection boundary", () => {
  it("passes through every explicitly approved field", () => {
    const payload = Object.fromEntries(
      PROJECTABLE_CREATOR_FIELDS.map((field) => [field, `${field} content`]),
    );
    expect(assertProjectableFields(payload)).toEqual(payload);
  });

  it("refuses any field that is not on the allowlist", () => {
    // An allowlist, not a blocklist: a field nobody approved is refused, so a
    // newly added internal field cannot leak by default.
    for (const field of [
      "contributionMargin",
      "foundryRevenue",
      "employeeQa",
      "founderNotes",
      "legalAnalysis",
      "internalIncidents",
      "commissionRate",
      "someFieldInventedNextQuarter",
    ]) {
      expect(() => assertProjectableFields({ [field]: "value" })).toThrow(ProjectionBoundaryError);
      expect(() => assertProjectableFields({ [field]: "value" })).toThrow(
        "NOTION_PROJECTION_REFUSED",
      );
    }
  });

  it("refuses restricted content that reaches an approved field", () => {
    const cases: Array<[string, string]> = [
      ["status", "Contribution margin is 41% this month"],
      ["performanceSummary", "See the P&L for the full picture"],
      ["thisWeek", "Unit economics review with the founders"],
      ["resources", "commission rate is 20%"],
      ["welcome", "Foundry revenue grew again"],
      ["approvals", "QA score for the editor was low"],
      ["currentPriorities", "Per founder notes, deprioritise this"],
      ["upcomingMeetings", "Legal analysis of the contract"],
      ["status", "internal incident 42 is still open"],
      ["resources", "api_key: abc123"],
      ["welcome", "your password is hunter2"],
    ];
    for (const [field, value] of cases)
      expect(() => assertProjectableFields({ [field]: value })).toThrow(
        "NOTION_PROJECTION_REFUSED",
      );
  });

  it("refuses rather than truncating, because a truncated secret is still leaked", () => {
    expect(() =>
      assertProjectableFields({ status: `ok. ${"x".repeat(5000)} contribution margin 40%` }),
    ).toThrow(ProjectionBoundaryError);
  });

  it("refuses a non-string value instead of coercing it", () => {
    expect(() => assertProjectableFields({ status: { nested: "object" } })).toThrow(
      "expected a string",
    );
    expect(() => assertProjectableFields({ status: 42 })).toThrow("expected a string");
  });

  it("skips null and undefined without failing", () => {
    expect(assertProjectableFields({ status: null, welcome: undefined, thisWeek: "ok" })).toEqual({
      thisWeek: "ok",
    });
  });

  it("names the offending field and reason so the failure is diagnosable", () => {
    try {
      assertProjectableFields({ founderNotes: "private" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectionBoundaryError);
      expect((error as ProjectionBoundaryError).field).toBe("founderNotes");
      expect((error as ProjectionBoundaryError).reason).toContain("allowlist");
    }
  });
});
