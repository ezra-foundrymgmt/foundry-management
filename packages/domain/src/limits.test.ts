import { describe, expect, it } from "vitest";
import { MAX_FOLLOWER_ESTIMATE, clampFollowerEstimate } from "./limits";
import {
  CONTRACT_STATUSES_SATISFYING_GATE,
  UNSET_TIMEZONE,
  hasRealTimezone,
  readCommissionRate,
} from "./types";

/**
 * The follower field accepted any number of digits while the server capped the
 * value at one billion, so a plausible typo (an extra zero) came back as the
 * literal string "INVALID_INPUT" with nothing naming the field. Sharing one
 * bound between the form and the schema is what keeps the two from drifting.
 */
describe("follower estimate stays inside the bound the schema enforces", () => {
  it("keeps ordinary values untouched", () => {
    expect(clampFollowerEstimate("184000")).toBe("184000");
  });

  it("strips anything that is not a digit", () => {
    expect(clampFollowerEstimate("1,840 followers")).toBe("1840");
  });

  it("clamps one digit past the cap -- the shape of the actual typo", () => {
    expect(clampFollowerEstimate("10000000000")).toBe(String(MAX_FOLLOWER_ESTIMATE));
  });

  it("accepts the cap itself rather than clamping it away", () => {
    expect(clampFollowerEstimate(String(MAX_FOLLOWER_ESTIMATE))).toBe(
      String(MAX_FOLLOWER_ESTIMATE),
    );
  });

  it("leaves the field clearable, because unknown is not zero", () => {
    expect(clampFollowerEstimate("")).toBe("");
    expect(clampFollowerEstimate("abc")).toBe("");
  });

  it("does not read leading zeros as a different number", () => {
    expect(clampFollowerEstimate("007")).toBe("7");
    expect(clampFollowerEstimate("0")).toBe("0");
  });
});

/**
 * Two activation gates could not fail, because `convert_prospect_to_creator`
 * asserted their answers at the moment of conversion: contract_status was the
 * literal 'SIGNED' before any agreement existed, and timezone defaulted to
 * 'UTC' for every creator because the prospect form has no timezone field.
 */
describe("gates that can actually fail", () => {
  it("only accepts a genuinely signed contract", () => {
    for (const status of ["SIGNED", "ACTIVE"])
      expect(CONTRACT_STATUSES_SATISFYING_GATE, status).toContain(status);
    // The state every newly converted creator now starts in.
    for (const status of ["PENDING", "SENT", "DECLINED", "EXPIRED"])
      expect(CONTRACT_STATUSES_SATISFYING_GATE, status).not.toContain(status);
  });

  it("treats the placeholder timezone as no answer at all", () => {
    expect(hasRealTimezone(UNSET_TIMEZONE)).toBe(false);
    expect(hasRealTimezone(null)).toBe(false);
    expect(hasRealTimezone("")).toBe(false);
    expect(hasRealTimezone("   ")).toBe(false);
  });

  it("accepts a real zone", () => {
    expect(hasRealTimezone("America/Los_Angeles")).toBe(true);
    // UTC is a legitimate answer when someone actually chose it; the defect was
    // the silent default, not the value.
    expect(hasRealTimezone("UTC")).toBe(true);
  });
});

/**
 * The commission rate is printed verbatim into a document a creator reads, so a
 * malformed setting must not propagate. It lives at organisation level because
 * Foundry charges everyone the same today, and a per-creator field with no
 * default is what left the first real welcome package unable to state terms.
 */
describe("organisation commission rate", () => {
  it("reads a configured rate", () => {
    expect(readCommissionRate({ defaultCommissionRate: 0.3 })).toBe(0.3);
    expect(readCommissionRate({ defaultCommissionRate: 0.42 })).toBe(0.42);
    // A string is how a hand-edited settings blob often arrives.
    expect(readCommissionRate({ defaultCommissionRate: "0.25" })).toBe(0.25);
  });

  /**
   * An earlier version returned 0.3 whenever the key was absent. No migration
   * or seed ever writes that key, so EVERY organisation was unconfigured and
   * every welcome package stated "Foundry takes 30%" as fact that nobody had
   * entered — routing around the guard built for exactly this case.
   */
  it("returns null when the organisation has not set one, never a default", () => {
    expect(readCommissionRate({})).toBeNull();
    expect(readCommissionRate(null)).toBeNull();
    expect(readCommissionRate(undefined)).toBeNull();
    expect(readCommissionRate({ defaultCommissionRate: null })).toBeNull();
    expect(readCommissionRate("not an object")).toBeNull();
  });

  it("refuses a rate that would misstate the arrangement to a creator", () => {
    // 0 would tell her Foundry takes nothing; >= 1 would claim all she earns.
    for (const bad of [0, 1, 1.5, -0.2, "thirty percent", Number.NaN, []])
      expect(readCommissionRate({ defaultCommissionRate: bad }), String(bad)).toBeNull();
  });
});
