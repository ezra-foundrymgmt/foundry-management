import { describe, expect, it } from "vitest";
import { MAX_FOLLOWER_ESTIMATE, clampFollowerEstimate } from "./limits";

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
