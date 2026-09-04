import { describe, expect, it } from "vitest";
import { preferOneRowPerPeriod } from "./metric-rows";

/**
 * Verified against staging before this existed: two sources reporting the same
 * creator-day each claiming $1000 summed to $2000 in the report, and 10 new
 * subscribers each became 20. The natural key
 * (creator_id, date, platform, source) lets both rows exist deliberately;
 * nothing downstream chose between them.
 */
describe("one claim per period wins, rather than every claim being added up", () => {
  const key = (row: { date: string; platform?: string | null }) =>
    `${row.date}|${row.platform ?? ""}`;

  it("collapses two sources for one day into a single row", () => {
    const rows = [
      { date: "2026-09-01", platform: "ONLYFANS", data_confidence: "MEASURED", revenue: 1000 },
      { date: "2026-09-01", platform: "ONLYFANS", data_confidence: "ESTIMATED", revenue: 1000 },
    ];
    const kept = preferOneRowPerPeriod(rows, key);
    expect(kept).toHaveLength(1);
    expect(kept.reduce((total, row) => total + row.revenue, 0)).toBe(1000);
  });

  it("prefers the measured claim over the estimated one", () => {
    const rows = [
      { date: "2026-09-01", platform: "ONLYFANS", data_confidence: "ESTIMATED", revenue: 700 },
      { date: "2026-09-01", platform: "ONLYFANS", data_confidence: "MEASURED", revenue: 1000 },
    ];
    expect(preferOneRowPerPeriod(rows, key)[0]?.revenue).toBe(1000);
  });

  it("prefers the later correction when confidence is equal", () => {
    const rows = [
      {
        date: "2026-09-01",
        platform: "ONLYFANS",
        data_confidence: "MEASURED",
        imported_at: "2026-09-02T10:00:00+00:00",
        revenue: 900,
      },
      {
        date: "2026-09-01",
        platform: "ONLYFANS",
        data_confidence: "MEASURED",
        imported_at: "2026-09-03T10:00:00+00:00",
        revenue: 1100,
      },
    ];
    expect(preferOneRowPerPeriod(rows, key)[0]?.revenue).toBe(1100);
  });

  it("does not let a row with no import time displace one that has it", () => {
    const rows = [
      {
        date: "2026-09-01",
        platform: "ONLYFANS",
        data_confidence: "MEASURED",
        imported_at: "2026-09-03T10:00:00+00:00",
        revenue: 1100,
      },
      { date: "2026-09-01", platform: "ONLYFANS", data_confidence: "MEASURED", revenue: 5 },
    ];
    expect(preferOneRowPerPeriod(rows, key)[0]?.revenue).toBe(1100);
  });

  it("keeps genuinely different days apart", () => {
    const rows = [
      { date: "2026-09-01", platform: "ONLYFANS", data_confidence: "MEASURED", revenue: 1000 },
      { date: "2026-09-02", platform: "ONLYFANS", data_confidence: "MEASURED", revenue: 1000 },
    ];
    expect(preferOneRowPerPeriod(rows, key).reduce((t, r) => t + r.revenue, 0)).toBe(2000);
  });

  it("keeps the same day on different platforms apart", () => {
    // Two platforms genuinely earn separately; that is not a duplicate claim.
    const rows = [
      { date: "2026-09-01", platform: "ONLYFANS", data_confidence: "MEASURED", revenue: 1000 },
      { date: "2026-09-01", platform: "FANSLY", data_confidence: "MEASURED", revenue: 400 },
    ];
    expect(preferOneRowPerPeriod(rows, key).reduce((t, r) => t + r.revenue, 0)).toBe(1400);
  });

  it("treats an unreadable confidence as the weakest rather than the strongest", () => {
    const rows = [
      { date: "2026-09-01", platform: "ONLYFANS", data_confidence: "WHATEVER", revenue: 5 },
      { date: "2026-09-01", platform: "ONLYFANS", data_confidence: "ESTIMATED", revenue: 900 },
    ];
    expect(preferOneRowPerPeriod(rows, key)[0]?.revenue).toBe(900);
  });

  it("passes a row through rather than dropping it when its key is unknown", () => {
    // Losing a measurement is a worse failure than keeping a duplicate.
    const rows = [{ date: "", platform: null, data_confidence: "MEASURED", revenue: 42 }];
    expect(preferOneRowPerPeriod(rows, () => null)).toHaveLength(1);
  });
});
