import { describe, expect, it } from "vitest";
import { findImportProblem, numberOrNull } from "./import-form";

const row = (overrides: Partial<Parameters<typeof findImportProblem>[0][number]> = {}) => ({
  identity: "POST-1",
  publishedAt: "2026-09-01",
  values: {},
  ...overrides,
});

describe("a blank field is not a zero", () => {
  it("reads a blank as not measured", () => {
    expect(numberOrNull("")).toBeNull();
    expect(numberOrNull("   ")).toBeNull();
  });

  it("keeps a real zero as a measurement of zero", () => {
    // The whole distinction: a post that genuinely got no outbound clicks is
    // a measurement, and must not be stored as "we never looked".
    expect(numberOrNull("0")).toBe(0);
  });

  it("does not let a typo become a measurement", () => {
    expect(numberOrNull("1,2oo")).toBeNull();
  });
});

describe("a batch is refused before anything is converted", () => {
  it("refuses an empty batch", () => {
    expect(findImportProblem([row({ identity: "" })], "social")).toBe("NO_ROWS");
  });

  /**
   * The regression this exists for. The panel builds an instant as
   * `new Date(\`${publishedAt}T12:00:00Z\`)`; with a blank date that is an
   * Invalid Date whose .toISOString() throws a RangeError. Thrown mid-submit it
   * escaped the handler, so `busy` never cleared and the panel sat on
   * "Importing…" forever with no error and no way back short of a reload.
   */
  it("refuses a social row with no publish date rather than throwing on it", () => {
    expect(findImportProblem([row({ publishedAt: "" })], "social")).toBe("MISSING_PUBLISHED_DATE");
    // Proves the failure mode the guard prevents is real.
    expect(() => new Date(`T12:00:00Z`).toISOString()).toThrow(RangeError);
  });

  it("does not demand a publish date in revenue mode, which has no such field", () => {
    expect(findImportProblem([row({ identity: "2026-09-01", publishedAt: "" })], "revenue")).toBeNull();
  });

  it("refuses a row carrying numbers but no identity rather than dropping it", () => {
    // Silently filtering it would report "Imported 1 post" for two entered.
    expect(
      findImportProblem([row(), row({ identity: "", values: { reach: "500" } })], "social"),
    ).toBe("ROW_WITHOUT_IDENTITY");
  });

  it("ignores a wholly empty spare row, which is just an unused slot", () => {
    expect(findImportProblem([row(), row({ identity: "" })], "social")).toBeNull();
  });

  it("refuses a metric that is not a number instead of recording it as unmeasured", () => {
    expect(findImportProblem([row({ values: { reach: "12o0" } })], "social")).toBe(
      "UNPARSEABLE_NUMBER",
    );
  });

  it("accepts a clean batch", () => {
    expect(findImportProblem([row({ values: { reach: "500", likes: "" } })], "social")).toBeNull();
  });
});
