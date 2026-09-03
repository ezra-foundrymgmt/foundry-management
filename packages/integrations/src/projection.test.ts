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

  it("sees through zero-width characters, soft hyphens and homoglyphs", () => {
    // Each of these was verified to walk straight past the raw-ASCII patterns.
    // A soft hyphen in particular is what a PDF or rich-text paste introduces,
    // so this is an accident as much as an attack.
    const evasions = [
      "contribution​margin is 41%", // zero-width space
      "contri­bution margin is 41%", // soft hyphen
      "cоntribution margin 41%", // Cyrillic o
      "﻿contribution margin", // byte order mark
      "contribution margin", // thin space
      "CONTRIBUTION   MARGIN", // case and spacing
    ];
    for (const value of evasions)
      expect(() => assertProjectableFields({ status: value })).toThrow("NOTION_PROJECTION_REFUSED");
  });

  it("catches plural forms of credential words", () => {
    for (const value of ["here are the tokens", "rotate the secrets", "api keys attached"])
      expect(() => assertProjectableFields({ resources: value })).toThrow(
        "NOTION_PROJECTION_REFUSED",
      );
  });

  it("still passes ordinary creator-facing copy", () => {
    // The screen must not be so broad that legitimate content is refused.
    const allowed = {
      welcome: "Welcome to Foundry, Madison — here is how we work together.",
      thisWeek: "Three posts, two stories, one collaboration call on Thursday.",
      performanceSummary: "Reach grew against your own baseline for the third week.",
      resources: "Brand kit, posting checklist, and the editing turnaround guide.",
    };
    expect(assertProjectableFields(allowed)).toEqual(allowed);
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

/**
 * The exact strings an adversarial audit walked past the value screen. Every one
 * renders to a human as ordinary Latin text, so they are built from code points
 * rather than typed — a reviewer cannot check them by eye, and a copy-paste
 * through any tool that normalises would silently turn the test into a tautology.
 */
describe("homoglyph and invisible-character evasions", () => {
  const cp = (...codes: number[]) => String.fromCodePoint(...codes);

  const EVASIONS: ReadonlyArray<[string, string]> = [
    ["Greek omicron", `c${cp(0x3bf)}ntribution margin 41%`],
    ["Greek rho", `${cp(0x3c1)}&l summary`],
    ["Greek alpha", `contribution m${cp(0x3b1)}rgin`],
    ["variation selector", `contribution${cp(0xfe0f)}margin is 41%`],
    ["invisible times", `contribution${cp(0x2062)}margin is 41%`],
    ["combining grapheme joiner", `contribution${cp(0x34f)}margin`],
    ["bidi isolate", `contribution${cp(0x2066)} margin`],
    ["dotless i", `contr${cp(0x131)}bution margin`],
    ["Cyrillic o", `c${cp(0x43e)}ntribution margin`],
    ["zero-width space", `contribution${cp(0x200b)}margin`],
  ];

  for (const [label, value] of EVASIONS)
    it(`refuses contribution margin hidden with a ${label}`, () => {
      expect(() => assertProjectableFields({ performanceSummary: value })).toThrow(
        ProjectionBoundaryError,
      );
    });

  it("still accepts the ordinary creator-facing copy these could be confused with", () => {
    // The screen has to stay usable. Over-folding that refused normal English
    // would push someone to route around the boundary rather than through it.
    expect(() =>
      assertProjectableFields({
        performanceSummary: "Reach up 12% and first-purchase conversion up 3 points.",
        approvedGrowthStrategy: "Post three Discovery pieces a week; margin of error is ±2%.",
        resources: "Café checklist, naïve-fan FAQ, résumé of last quarter.",
      }),
    ).not.toThrow();
  });
});
