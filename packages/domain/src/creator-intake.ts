import { BOUNDARY_TYPES, type BoundarySeverity, type BoundaryType } from "./types";

/**
 * Turns one submission of the Foundry MGMT Model Information Sheet into the
 * records CreatorOS actually stores.
 *
 * Pure on purpose. This is the layer that decides what a creator's answers
 * MEAN, and every judgement it makes is one that later reaches a document she
 * reads or a constraint the system operates under — so it is written where it
 * can be tested exhaustively without a database in the way.
 *
 * The governing rule throughout is the one the rest of this codebase already
 * lives by: an answer that was not given produces no record. Not an empty
 * string, not a zero, not a row. The single most dangerous thing this mapper
 * could do is manufacture a fact about a creator out of her silence.
 */

/**
 * Apps Script's Form-bound trigger identifies an answer by its ITEM id
 * (`ItemResponse.getItem().getId()`), which is stable across re-wording a
 * question. Keying on question TITLE — what the Sheet-bound trigger gives —
 * would break silently the first time somebody fixed a typo.
 *
 * Read off the live form on 2026-09-04. The one entry id, which is a DIFFERENT
 * namespace and is used only to build a prefilled URL, lives in
 * INTAKE_REFERENCE_ENTRY_ID below.
 */
export const INTAKE_ITEM_IDS = {
  referenceCode: 1136407967,
  stageOrOnlyFansUsername: 1226321369,
  age: 1730406639,
  languages: 990313522,
  contentComfort: 1161196469,
  hardNos: 1157234256,
  themes: 1876767843,
  openToCollaborations: 616812229,
  daysPerWeek: 1208052245,
  shootingTimes: 215284023,
  scheduleRestrictions: 2129322875,
  persona: 1211428679,
  audience: 596644371,
  funFacts: 712655507,
  goals: 683472643,
  instagram: 1226142665,
  tiktok: 2132151428,
  twitter: 859429748,
  adultConfirmation: 860653502,
} as const;

/**
 * The `entry.NNN` parameter of the Reference Code question.
 *
 * Google exposes no API that derives this from the item id — the three id
 * namespaces (prefill entry, Apps Script item, REST question) are unrelated —
 * so it is read once off a prefilled URL and pinned here.
 */
export const INTAKE_REFERENCE_ENTRY_ID = 583367904;

export const INTAKE_FORM_VIEW_URL =
  "https://docs.google.com/forms/d/e/1FAIpQLSeWmuyF-jLBB8OPM9NgYMl53EYR3EApHLY_U5qawxuORo3FKg/viewform";

/** Minimum age Foundry will onboard. Not a legal determination; a refusal line. */
export const MINIMUM_CREATOR_AGE = 18;

export interface IntakeAnswer {
  itemId: number;
  title: string;
  /** Checkbox items give many; every other type gives one. */
  values: string[];
}

export interface IntakeSubmissionInput {
  answers: IntakeAnswer[];
  respondentEmail?: string | null;
}

export interface MappedBoundary {
  intakeKey: string;
  boundaryType: BoundaryType;
  description: string;
  severity: BoundarySeverity;
  requiresCreatorApproval: boolean;
  source: string;
}

export interface MappedTruthItem {
  intakeKey: string;
  itemType: "approved" | "requires_creator_confirmation" | "prohibited";
  category: string;
  statement: string;
  status: string;
}

export interface MappedPillar {
  name: string;
  description: string;
}

export interface MappedSocialHandle {
  provider: "INSTAGRAM" | "TIKTOK" | "X";
  handle: string;
}

export interface MappedIntake {
  /** creator_brand_profiles columns. Only keys the creator actually answered. */
  brandProfile: Record<string, string | string[] | number>;
  boundaries: MappedBoundary[];
  truthItems: MappedTruthItem[];
  contentPillars: MappedPillar[];
  socialHandles: MappedSocialHandle[];
  referenceCode: string | null;
  respondentEmail: string | null;
  /** Her answer to "Stage Name / OF Username". Never overwrites creators.stage_name. */
  statedStageName: string | null;
  adult: {
    attested: boolean;
    reportedAge: number | null;
    rawAge: string | null;
    /** True only when a real number below the line was given. Unknown is not below. */
    belowMinimum: boolean;
  };
  /** Work a person must do, because the answer had no structure to lift. */
  reviewNotes: string[];
  /** Questions this mapper does not know, preserved rather than dropped. */
  unrecognized: Array<{ itemId: number; title: string; values: string[] }>;
}

function clean(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Splits a free-text answer into discrete items, or reports that it is prose.
 *
 * A creator answering "Hard NOs" may write a list or a paragraph. Turning a
 * paragraph into three boundaries by cutting it at commas would invent limits
 * she never drew, and a boundary is the one record in this system that must
 * never be invented — it is what constrains everything CreatorOS later
 * suggests. So: split only where the creator herself created structure
 * (newlines, semicolons, or bullet marks), and treat anything else as one item.
 */
function splitAuthoredList(value: string): string[] {
  return value
    .split(/\r?\n|;|•|·|^\s*[-*]\s+/gm)
    .map((part) => part.replace(/^\s*[-*•]\s*/, "").trim())
    .filter((part) => part.length > 0);
}

/** A stable key so re-applying a submission corrects rather than duplicates. */
function keyOf(prefix: string, value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `intake:${prefix}:${slug}`;
}

/** Strips the decorations people put around a username. */
function normalizeHandle(value: string): string | null {
  const withoutUrl = value.trim().replace(/^https?:\/\/[^/]+\//i, "");
  const handle = withoutUrl.replace(/^@+/, "").replace(/[/?#].*$/, "").trim();
  return handle.length === 0 ? null : handle;
}

const ITEM_BY_ID = new Map<number, keyof typeof INTAKE_ITEM_IDS>(
  Object.entries(INTAKE_ITEM_IDS).map(([name, id]) => [id, name as keyof typeof INTAKE_ITEM_IDS]),
);

export function mapIntakeSubmission(input: IntakeSubmissionInput): MappedIntake {
  const answers = new Map<keyof typeof INTAKE_ITEM_IDS, string[]>();
  const unrecognized: MappedIntake["unrecognized"] = [];

  for (const answer of input.answers) {
    const known = ITEM_BY_ID.get(answer.itemId);
    const values = answer.values.map((v) => v.trim()).filter((v) => v.length > 0);
    if (!known) {
      // Somebody added a question and told nobody. Dropping it would mean a
      // creator answered something and the answer evaporated.
      if (values.length > 0) unrecognized.push({ itemId: answer.itemId, title: answer.title, values });
      continue;
    }
    if (values.length > 0) answers.set(known, values);
  }

  const single = (key: keyof typeof INTAKE_ITEM_IDS): string | null =>
    clean(answers.get(key)?.[0]);

  const brandProfile: MappedIntake["brandProfile"] = {};
  const boundaries: MappedBoundary[] = [];
  const truthItems: MappedTruthItem[] = [];
  const contentPillars: MappedPillar[] = [];
  const socialHandles: MappedSocialHandle[] = [];
  const reviewNotes: string[] = [];

  // ---- brand profile ------------------------------------------------------
  const persona = single("persona");
  if (persona) brandProfile["positioning_statement"] = persona;
  const audience = single("audience");
  if (audience) brandProfile["primary_audience"] = audience;
  const funFacts = single("funFacts");
  if (funFacts) brandProfile["known_for"] = funFacts;
  const goals = single("goals");
  if (goals) brandProfile["creator_goals"] = goals;
  const shootingTimes = single("shootingTimes");
  if (shootingTimes) brandProfile["preferred_shooting_times"] = shootingTimes;

  const languages = single("languages");
  if (languages) {
    const list = languages
      .split(/[,\n;]/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (list.length > 0) brandProfile["languages"] = list;
  }

  const daysRaw = single("daysPerWeek");
  if (daysRaw) {
    const digits = daysRaw.match(/\d+/);
    const days = digits ? Number.parseInt(digits[0], 10) : Number.NaN;
    // A creator writing "depends" gets no number rather than a fabricated one,
    // and the operator is told a human has to read it.
    if (Number.isInteger(days) && days >= 0 && days <= 7) brandProfile["content_days_per_week"] = days;
    else reviewNotes.push(`Days available per week could not be read as a number: "${daysRaw}".`);
  }

  // ---- what she will do ---------------------------------------------------
  /**
   * A ticked box is a statement; an unticked box is silence.
   *
   * The obvious-looking move here is to record every UNticked content type as
   * prohibited. That would be the exact defect this codebase keeps finding: a
   * creator who simply did not tick "Fetish" has not told us she refuses it,
   * and writing `prohibited` would put words in her mouth that later constrain
   * — or worse, appear in a document she reads as though she had said them.
   * Only her Hard NOs answer produces a prohibition.
   */
  for (const value of answers.get("contentComfort") ?? [])
    truthItems.push({
      intakeKey: keyOf("approved", value),
      itemType: "approved",
      category: "CONTENT_TYPE",
      statement: value,
      status: "CREATOR_STATED",
    });

  // ---- what she will not do ----------------------------------------------
  const hardNos = single("hardNos");
  if (hardNos)
    for (const item of splitAuthoredList(hardNos)) {
      boundaries.push({
        intakeKey: keyOf("hard-no", item),
        // CONTENT because the question sits in the content section and asks
        // about content — derived from which question was answered, never
        // guessed from the words in the answer.
        boundaryType: "CONTENT",
        description: item,
        severity: "HARD",
        requiresCreatorApproval: false,
        source: "INTAKE_FORM",
      });
      truthItems.push({
        intakeKey: keyOf("prohibited", item),
        itemType: "prohibited",
        category: "HARD_NO",
        statement: item,
        status: "CREATOR_STATED",
      });
    }

  const scheduleRestrictions = single("scheduleRestrictions");
  if (scheduleRestrictions)
    for (const item of splitAuthoredList(scheduleRestrictions))
      boundaries.push({
        intakeKey: keyOf("schedule", item),
        boundaryType: "SCHEDULING",
        description: item,
        severity: "SOFT",
        requiresCreatorApproval: false,
        source: "INTAKE_FORM",
      });

  const collaborations = single("openToCollaborations");
  if (collaborations && /^no$/i.test(collaborations))
    boundaries.push({
      intakeKey: "intake:collaboration:declined",
      boundaryType: "COLLABORATION",
      description: "Not open to collaborations with other creators.",
      severity: "HARD",
      requiresCreatorApproval: false,
      source: "INTAKE_FORM",
    });
  // A "Yes" records nothing: permission to ask is not a boundary.

  // ---- themes -------------------------------------------------------------
  /**
   * Pillars only where the creator wrote a list.
   *
   * content_pillars.name is a label an operator plans against, and it carries a
   * unique(creator_id, name) constraint. Cutting a paragraph into fragments to
   * fill it would produce pillars named after half-sentences that nobody can
   * use and that can never be cleanly replaced. When she wrote prose, the prose
   * is kept and a person turns it into pillars.
   */
  const themes = single("themes");
  if (themes) {
    const items = splitAuthoredList(themes).filter((item) => item.length <= 60);
    if (items.length >= 2) {
      const seen = new Set<string>();
      for (const item of items) {
        const name = item.slice(0, 60);
        if (seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        contentPillars.push({ name, description: item });
      }
    } else {
      reviewNotes.push(
        "Content themes arrived as prose rather than a list, so no pillars were created. Read the submission and add them by hand.",
      );
    }
  }

  // ---- handles ------------------------------------------------------------
  for (const [key, provider] of [
    ["instagram", "INSTAGRAM"],
    ["tiktok", "TIKTOK"],
    ["twitter", "X"],
  ] as const) {
    const raw = single(key);
    if (!raw) continue;
    const handle = normalizeHandle(raw);
    if (handle) socialHandles.push({ provider, handle });
  }

  // ---- age ----------------------------------------------------------------
  const rawAge = single("age");
  const ageDigits = rawAge?.match(/\d+/);
  const reportedAge = ageDigits ? Number.parseInt(ageDigits[0], 10) : null;
  const usableAge = reportedAge !== null && Number.isInteger(reportedAge) && reportedAge < 130
    ? reportedAge
    : null;
  if (rawAge && usableAge === null)
    reviewNotes.push(`Age could not be read as a number: "${rawAge}".`);

  const attested = (answers.get("adultConfirmation") ?? []).length > 0;

  return {
    brandProfile,
    boundaries,
    truthItems,
    contentPillars,
    socialHandles,
    referenceCode: single("referenceCode"),
    respondentEmail: clean(input.respondentEmail ?? undefined),
    statedStageName: single("stageOrOnlyFansUsername"),
    adult: {
      attested,
      reportedAge: usableAge,
      rawAge,
      // Only a real number below the line counts. A missing or unreadable age
      // is unknown, and unknown is not "underage" any more than it is "adult".
      belowMinimum: usableAge !== null && usableAge < MINIMUM_CREATOR_AGE,
    },
    reviewNotes,
    unrecognized,
  };
}

/**
 * Why a mapped submission must not be applied to a creator record.
 *
 * Returned rather than thrown: an operator needs to see every reason at once on
 * the review screen, not the first one that tripped.
 */
export function intakeBlockers(mapped: MappedIntake): string[] {
  const blockers: string[] = [];
  if (!mapped.referenceCode) blockers.push("NO_REFERENCE_CODE");
  if (!mapped.adult.attested) blockers.push("ADULT_ATTESTATION_MISSING");
  if (mapped.adult.belowMinimum) blockers.push("REPORTED_AGE_BELOW_MINIMUM");
  return blockers;
}

/** The link a creator opens. The code is visible to her by design. */
export function composeIntakeUrl(referenceCode: string): string {
  const url = new URL(INTAKE_FORM_VIEW_URL);
  url.searchParams.set("usp", "pp_url");
  url.searchParams.set(`entry.${INTAKE_REFERENCE_ENTRY_ID}`, referenceCode);
  return url.toString();
}

/** Reference code shape: the creator number, plus enough randomness that a
 * mistyped or forwarded code cannot land on a neighbouring creator. */
export function composeReferenceCode(creatorNumber: string, randomSuffix: string): string {
  return `${creatorNumber}-${randomSuffix.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4)}`;
}

/** Re-exported so callers can validate a boundary type without reaching in. */
export { BOUNDARY_TYPES };
