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
// Separators tolerate zero or more of whitespace, punctuation, OR symbol
// characters, not just whitespace: stripping a zero-width space or soft
// hyphen joins the two words (so zero separators must still match), but a
// literal, visible separator -- "contribution-margin", "commission, rate",
// "unit_economics" -- survives canonicalize() completely unchanged. It only
// collapses whitespace runs and folds confusables/format characters; it does
// not touch punctuation. A pattern that only ever skipped \s therefore missed
// every punctuation-joined variant of a restricted phrase.
const SEP = "[\\s\\p{P}\\p{S}]*";
function restricted(source: string): RegExp {
  return new RegExp(source.replaceAll(" ", SEP), "iu");
}
const RESTRICTED_VALUE_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "contribution margin", pattern: restricted("contribution (margin|profit)") },
  {
    label: "profit and loss",
    pattern: restricted("\\bp & l\\b|profit and loss"),
  },
  { label: "unit economics", pattern: restricted("unit economics") },
  { label: "commission rate", pattern: restricted("commission rate") },
  { label: "Foundry revenue", pattern: restricted("foundry revenue") },
  { label: "employee QA", pattern: restricted("employee qa|qa score") },
  { label: "founder notes", pattern: restricted("founder note") },
  { label: "legal analysis", pattern: restricted("legal (analysis|opinion|advice)") },
  { label: "internal incident", pattern: restricted("internal incident|incident report") },
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

/**
 * Letters that render as Latin but are not, folded so a homoglyph cannot walk a
 * restricted phrase past the value screen.
 *
 * Greek was missing, which an adversarial audit demonstrated: "cοntribution
 * margin" spelled with a Greek omicron passed, while the Cyrillic spelling of
 * the same string was correctly refused — so the class read as closed when only
 * one script in it was. Dotless i was missing for the same reason.
 *
 * The tests cover this table by code point, because the entries here are
 * indistinguishable from Latin on screen and a reviewer cannot check them by
 * eye.
 */
const CONFUSABLES: ReadonlyArray<[RegExp, string]> = [
  // Cyrillic
  [/[аА]/g, "a"],
  [/[вВ]/g, "b"],
  [/[сС]/g, "c"],
  [/[ԁ]/g, "d"],
  [/[еЕ]/g, "e"],
  [/[һНн]/g, "h"],
  [/[іІ]/g, "i"],
  [/[кК]/g, "k"],
  [/[мМ]/g, "m"],
  [/[оО]/g, "o"],
  [/[рР]/g, "p"],
  [/[ѕ]/g, "s"],
  [/[тТ]/g, "t"],
  [/[хХ]/g, "x"],
  [/[уУ]/g, "y"],
  // Greek
  [/[αΑ]/g, "a"],
  [/[Β]/g, "b"],
  [/[εΕ]/g, "e"],
  [/[Η]/g, "h"],
  [/[ιΙ]/g, "i"],
  [/[κΚ]/g, "k"],
  [/[Μ]/g, "m"],
  [/[Ν]/g, "n"],
  [/[οΟ]/g, "o"],
  [/[ρΡ]/g, "p"],
  [/[τΤ]/g, "t"],
  [/[μ]/g, "u"],
  [/[ν]/g, "v"],
  [/[χΧ]/g, "x"],
  [/[Υ]/g, "y"],
  [/[Ζ]/g, "z"],
  // Latin letters that survive NFKC unchanged
  [/[ıɩ]/g, "i"],
  [/[ł]/g, "l"],
  [/[ɡ]/g, "g"],
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
  // Every format character, by Unicode property rather than by list. The list
  // version named six ranges and missed the rest, and an audit walked
  // "contribution margin" past it with an invisible-times operator, a bidi
  // isolate and a variation selector, none of which a reader sees. The property
  // is the whole class, so it cannot fall behind a Unicode revision.
  canonical = canonical.replace(/\p{Cf}/gu, "");
  // Invisible combining marks are Mn, not Cf: the combining grapheme joiner and
  // the variation selectors, written as escapes because they render as nothing.
  // Only those, because stripping all of Mn would mangle ordinary accented and
  // Indic text.
  canonical = canonical.replace(/[\u034F\uFE00-\uFE0F]/g, "");
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
