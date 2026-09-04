import { describe, expect, it } from "vitest";
import { composeWelcomePackage, renderWelcomePackage } from "./welcome-package";
import type { WelcomePackageInput } from "./welcome-package";

/**
 * This is the first artifact a creator judges Foundry on, and the creators
 * being onboarded are frequently older and more experienced than the person
 * onboarding them. The temptation is to lead with confident projections. These
 * tests exist to make that impossible.
 */
const complete: WelcomePackageInput = {
  stageName: "Nova Reign",
  team: [
    { name: "Ezra", role: "Growth" },
    { name: "Payton", role: "Creator Success" },
  ],
  baseline: {
    metrics: {
      date: "2026-08-31",
      reach: 120_000,
      profileVisits: 4_000,
      outboundClicks: 900,
      newSubscribers: 200,
      firstBuyers: 50,
      revenue: 5_000,
    },
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
    unmeasuredDimensions: [],
    dataConfidence: "MEASURED",
  },
  boundaries: [
    { boundaryType: "CONTENT", description: "No face-visible content", severity: "HARD" },
  ],
  commitments: [{ title: "Competitor research", owner: "Ezra", dueAt: "2026-09-10" }],
  commissionRate: 0.35,
  reportingCadence: "DAILY",
  creatorTimezone: "America/Los_Angeles",
};

describe("a complete welcome package", () => {
  it("reports itself complete with nothing missing", () => {
    const pkg = composeWelcomePackage(complete);
    expect(pkg.complete).toBe(true);
    expect(pkg.blockingGaps).toEqual([]);
  });

  it("states the measured starting point with its period and confidence", () => {
    const body = composeWelcomePackage(complete)
      .sections.find((s) => s.heading === "Where you are starting from")!
      .body.join(" ");
    expect(body).toContain("2026-08-01");
    expect(body).toContain("MEASURED");
    expect(body).toContain("$5,000");
    // The derived rate, computed rather than asserted: 50 of 200 is 25%.
    expect(body).toContain("25.0%");
  });

  it("reads the creator's own boundaries back to them", () => {
    const body = composeWelcomePackage(complete)
      .sections.find((s) => s.heading === "What we will not do")!
      .body.join(" ");
    expect(body).toContain("No face-visible content");
  });
});

describe("it refuses to invent what nobody measured", () => {
  it("says the baseline is missing rather than estimating one", () => {
    const pkg = composeWelcomePackage({ ...complete, baseline: null });
    const section = pkg.sections.find((s) => s.heading === "Where you are starting from")!;
    expect(section.body).toEqual([]);
    expect(section.missing).toContain("not measured your baseline");
    expect(pkg.complete).toBe(false);
    expect(pkg.blockingGaps).toContain("Freeze a baseline");
  });

  it("names an unmeasured dimension as absent, never as zero", () => {
    // A creator reading "reach: 0" would reasonably conclude her content
    // reached nobody. The truth is that Foundry has not ingested it yet.
    const pkg = composeWelcomePackage({
      ...complete,
      baseline: {
        ...complete.baseline!,
        metrics: { ...complete.baseline!.metrics, reach: 0, profileVisits: 0, outboundClicks: 0 },
        unmeasuredDimensions: ["reach", "profileVisits", "outboundClicks"],
      },
    });
    const body = pkg.sections
      .find((s) => s.heading === "Where you are starting from")!
      .body.join(" ");
    expect(body).toContain("Not yet measured");
    expect(body).toContain("not zero");
    // The figure itself is never printed as a result.
    expect(body).not.toMatch(/reach: 0/i);
  });

  it("blocks sending when no commission rate is recorded", () => {
    const pkg = composeWelcomePackage({ ...complete, commissionRate: null });
    expect(pkg.blockingGaps).toContain("Record the commission rate");
    expect(
      pkg.sections.find((s) => s.heading === "Our arrangement")!.missing,
    ).toContain("Do not send this");
  });

  it("blocks sending when no boundaries were captured", () => {
    const pkg = composeWelcomePackage({ ...complete, boundaries: [] });
    expect(pkg.blockingGaps).toContain("Record creator boundaries");
  });

  it("blocks sending when nobody owns the creator", () => {
    const pkg = composeWelcomePackage({ ...complete, team: [] });
    expect(pkg.blockingGaps).toContain("Assign a Foundry owner");
  });

  it("still produces every section when data is missing, so the gaps are visible", () => {
    // A package that silently dropped sections would let an operator send an
    // incomplete document without noticing what was absent.
    const pkg = composeWelcomePackage({
      stageName: "Nobody",
      team: [],
      baseline: null,
      boundaries: [],
      commitments: [],
      commissionRate: null,
      reportingCadence: null,
      creatorTimezone: null,
    });
    expect(pkg.sections).toHaveLength(6);
    expect(pkg.sections.every((s) => s.missing !== undefined)).toBe(true);
  });
});

describe("rendering", () => {
  it("renders missing sections as a stated gap rather than an empty heading", () => {
    const markdown = renderWelcomePackage(
      composeWelcomePackage({ ...complete, baseline: null }),
    );
    expect(markdown).toContain("# Welcome to Foundry, Nova Reign");
    expect(markdown).toContain("_We have not measured your baseline yet");
  });

  it("puts the creator's own boundaries in the rendered document", () => {
    const markdown = renderWelcomePackage(composeWelcomePackage(complete));
    expect(markdown).toContain("- No face-visible content (CONTENT, HARD)");
  });
});
