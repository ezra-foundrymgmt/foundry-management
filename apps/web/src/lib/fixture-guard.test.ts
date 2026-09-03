import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Structural guard: no page or component may render demo fixtures without first
 * consulting the environment mode.
 *
 * This is the failure that mattered most. A live deployment was showing Madison
 * Carter, Ava Monroe and invented contribution margins as though they were
 * Foundry's real data, because nine pages imported seed fixtures with no mode
 * check at all. A reviewer will not catch the tenth one; this will.
 */

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The actual demo datasets. Types and constants from the same package are fine. */
const FIXTURE_EXPORTS = ["creators", "prospects", "tasks", "reports", "contentPerformance"];

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith(".tsx") ? [full] : [];
  });
}

function importsFixtures(source: string): boolean {
  const match = /import\s+\{([^}]*)\}\s+from\s+"@creatoros\/domain"/.exec(source);
  if (!match) return false;
  const named = (match[1] ?? "").split(",").map(
    (part) =>
      part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        ?.trim() ?? "",
  );
  return named.some((name) => FIXTURE_EXPORTS.includes(name));
}

function consultsMode(source: string): boolean {
  return /isMockMode|useDemoMode/.test(source);
}

describe("no unguarded demo fixtures on UI paths", () => {
  const files = walk(SRC).filter((file) => !file.endsWith(".test.tsx"));

  it("finds UI files to check", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("every file importing a demo dataset also consults the environment mode", () => {
    const offenders = files.filter((file) => {
      const source = readFileSync(file, "utf8");
      return importsFixtures(source) && !consultsMode(source);
    });
    expect(
      offenders.map((file) => path.relative(SRC, file)),
      "these render demo data without checking whether the app is live",
    ).toEqual([]);
  });

  it("no UI file reads the un-contracted demo env var directly", () => {
    // NEXT_PUBLIC_CREATOROS_DEMO_MODE sat outside the zod contract and defaulted
    // to demo when unset, so a live deployment that forgot it showed fixtures.
    // The mode now comes from the server through DemoModeProvider.
    const offenders = files.filter((file) => {
      if (file.endsWith("mode-provider.tsx")) return false;
      return readFileSync(file, "utf8").includes("NEXT_PUBLIC_CREATOROS_DEMO_MODE");
    });
    expect(offenders.map((file) => path.relative(SRC, file))).toEqual([]);
  });
});
