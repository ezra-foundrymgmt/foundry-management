/**
 * The data-classification boundary for creator-facing projections.
 *
 * Notion creator hubs are readable by the creator. CreatorOS holds material a
 * creator must never see — Foundry contribution margin and P&L, employee QA,
 * founder notes, legal analysis, internal incidents, credentials. This module
 * is the single enforcement point for that boundary.
 *
 * It is an allowlist, not a blocklist: a field nobody has explicitly approved
 * for projection is refused. A blocklist silently leaks every field someone
 * forgets to add to it.
 */

/** The only fields that may be written to a creator-facing Notion projection. */
export const PROJECTABLE_CREATOR_FIELDS = [
  "status",
  "welcome",
  "currentPriorities",
  "thisWeek",
  "creatorDeliverables",
  "foundryDeliverables",
  "contentRequests",
  "approvals",
  "approvedGrowthStrategy",
  "performanceSummary",
  "upcomingMeetings",
  "resources",
] as const;

export type ProjectableCreatorField = (typeof PROJECTABLE_CREATOR_FIELDS)[number];

/**
 * Terms whose presence in a *value* indicates internal material that reached a
 * projectable field by mistake. This is a backstop behind the allowlist, not
 * the primary control: it catches an approved field carrying the wrong content.
 */
// Separators are `\s*`, not `\s+`: stripping a zero-width space or soft hyphen
// joins the two words, and a pattern requiring whitespace would then miss the
// very evasion the stripping exists to defeat.
const RESTRICTED_VALUE_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "contribution margin", pattern: /contribution\s*(margin|profit)/i },
  { label: "profit and loss", pattern: /\bp\s*&\s*l\b|profit\s*and\s*loss/i },
  { label: "unit economics", pattern: /unit\s*economics/i },
  { label: "commission rate", pattern: /commission\s*rate/i },
  { label: "Foundry revenue", pattern: /foundry\s*revenue/i },
  { label: "employee QA", pattern: /employee\s*qa|qa\s*score/i },
  { label: "founder notes", pattern: /founder\s*note/i },
  { label: "legal analysis", pattern: /legal\s*(analysis|opinion|advice)/i },
  { label: "internal incident", pattern: /internal\s*incident|incident\s*report/i },
  { label: "credential", pattern: /\b(api[_\s-]?keys?|secrets?|passwords?|bearer|tokens?)\b/i },
];

export class ProjectionBoundaryError extends Error {
  constructor(
    readonly field: string,
    readonly reason: string,
  ) {
    super(`NOTION_PROJECTION_REFUSED: ${field} (${reason})`);
    this.name = "ProjectionBoundaryError";
  }
}

function isProjectableField(field: string): field is ProjectableCreatorField {
  return (PROJECTABLE_CREATOR_FIELDS as readonly string[]).includes(field);
}

/** Confusable Latin letters, folded so homoglyph substitution cannot evade a pattern. */
const CONFUSABLES: ReadonlyArray<[RegExp, string]> = [
  [/[аА]/g, "a"],
  [/[еЕ]/g, "e"],
  [/[оО]/g, "o"],
  [/[рР]/g, "p"],
  [/[сС]/g, "c"],
  [/[хХ]/g, "x"],
  [/[уУ]/g, "y"],
  [/[іІ]/g, "i"],
  [/[ԁ]/g, "d"],
  [/[ѕ]/g, "s"],
];

/**
 * Canonical form used only for pattern matching; the original value is what
 * gets stored or refused.
 *
 * Without this, the value screen was decorative: a zero-width space, a soft
 * hyphen from a PDF paste, or a Cyrillic homoglyph walked "contribution margin"
 * straight past it. Normalizing to NFKC, stripping format characters, folding
 * confusables and collapsing all Unicode whitespace closes the mechanical
 * evasions. It cannot close paraphrase — the allowlist is what actually carries
 * this boundary, and this remains a backstop.
 */
function canonicalize(value: string): string {
  let canonical = value.normalize("NFKC");
  // Cf (format) characters written as escapes so they are visible in review:
  // soft hyphen, zero-width space/non-joiner/joiner, bidi marks, word joiner, BOM.
  canonical = canonical.replace(/[\u00AD\u200B-\u200F\u2060\uFEFF]/g, "");
  for (const [pattern, replacement] of CONFUSABLES)
    canonical = canonical.replace(pattern, replacement);
  return canonical.replace(/\s+/g, " ").toLowerCase();
}

/**
 * Validates a projection payload. Refuses rather than redacting: silently
 * truncating restricted content still leaks the part that fit, and hides the
 * fact that a caller tried to project something it should not have.
 */
export function assertProjectableFields(
  fields: Readonly<Record<string, unknown>>,
): Record<ProjectableCreatorField, string> {
  const safe: Partial<Record<ProjectableCreatorField, string>> = {};
  for (const [field, value] of Object.entries(fields)) {
    if (!isProjectableField(field))
      throw new ProjectionBoundaryError(field, "field is not on the creator-facing allowlist");
    if (value === null || value === undefined) continue;
    if (typeof value !== "string")
      throw new ProjectionBoundaryError(field, `expected a string, received ${typeof value}`);
    const canonical = canonicalize(value);
    const restricted = RESTRICTED_VALUE_PATTERNS.find((entry) => entry.pattern.test(canonical));
    if (restricted) throw new ProjectionBoundaryError(field, `value mentions ${restricted.label}`);
    safe[field] = value;
  }
  return safe as Record<ProjectableCreatorField, string>;
}
