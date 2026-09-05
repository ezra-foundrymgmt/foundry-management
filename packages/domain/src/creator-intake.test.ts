import { describe, expect, it } from "vitest";
import {
  INTAKE_ITEM_IDS,
  composeIntakeUrl,
  composeReferenceCode,
  intakeBlockers,
  mapIntakeSubmission,
  type IntakeAnswer,
} from "./creator-intake";

function answer(key: keyof typeof INTAKE_ITEM_IDS, ...values: string[]): IntakeAnswer {
  return { itemId: INTAKE_ITEM_IDS[key], title: key, values };
}

function map(...answers: IntakeAnswer[]) {
  return mapIntakeSubmission({ answers });
}

/**
 * The single most dangerous thing this mapper could do is turn a creator's
 * silence into a statement about her. Every test in this block is a shape of
 * that failure.
 */
describe("silence never becomes a statement", () => {
  it("does not turn an unticked content type into a prohibition", () => {
    const result = map(answer("contentComfort", "Lingerie", "Topless"));
    // She ticked two of eleven. The other nine are things she did not answer,
    // not things she refused.
    expect(result.truthItems).toHaveLength(2);
    expect(result.truthItems.every((item) => item.itemType === "approved")).toBe(true);
    expect(result.truthItems.map((item) => item.statement)).toEqual(["Lingerie", "Topless"]);
    expect(result.boundaries).toHaveLength(0);
  });

  it("produces no records at all from a form submitted empty", () => {
    const result = map();
    expect(result.truthItems).toHaveLength(0);
    expect(result.boundaries).toHaveLength(0);
    expect(result.contentPillars).toHaveLength(0);
    expect(result.socialHandles).toHaveLength(0);
    expect(result.brandProfile).toEqual({});
    expect(result.adult.reportedAge).toBeNull();
  });

  it("writes no brand-profile key for a question left blank", () => {
    const result = map(answer("persona", "Playful girl next door"));
    expect(result.brandProfile).toEqual({ positioning_statement: "Playful girl next door" });
    // Not present as null, not present as "" -- absent.
    expect("primary_audience" in result.brandProfile).toBe(false);
    expect("known_for" in result.brandProfile).toBe(false);
  });

  it("treats whitespace as no answer", () => {
    const result = map(answer("persona", "   "), answer("funFacts", "\n\t "));
    expect(result.brandProfile).toEqual({});
  });

  it("records nothing when she IS open to collaborations", () => {
    // Permission to ask is not a boundary. Only a "No" constrains anything.
    expect(map(answer("openToCollaborations", "Yes")).boundaries).toHaveLength(0);
    const declined = map(answer("openToCollaborations", "No")).boundaries;
    expect(declined).toHaveLength(1);
    expect(declined[0]).toMatchObject({ boundaryType: "COLLABORATION", severity: "HARD" });
  });
});

describe("boundaries are split only where the creator created structure", () => {
  it("splits a list she wrote as a list", () => {
    const result = map(answer("hardNos", "No feet content\nNo face on free platforms\nNo anal"));
    expect(result.boundaries.map((b) => b.description)).toEqual([
      "No feet content",
      "No face on free platforms",
      "No anal",
    ]);
    expect(result.boundaries.every((b) => b.severity === "HARD")).toBe(true);
    expect(result.boundaries.every((b) => b.boundaryType === "CONTENT")).toBe(true);
  });

  it("handles bullets and semicolons she typed herself", () => {
    const result = map(answer("hardNos", "- No feet\n- No fetish; no roleplay"));
    expect(result.boundaries.map((b) => b.description)).toEqual([
      "No feet",
      "No fetish",
      "no roleplay",
    ]);
  });

  /**
   * The tempting bug: split prose on commas. "I'm fine with most things, but
   * nothing involving my family, and no face on free sites" is ONE thought.
   * Cutting it at commas yields "I'm fine with most things" as a HARD boundary
   * -- a limit she never drew, which then constrains everything the system
   * suggests and can appear in a document she reads.
   */
  it("keeps prose as one boundary rather than cutting it at commas", () => {
    const prose = "I'm fine with most things, but nothing involving my family, and no face on free sites";
    const result = map(answer("hardNos", prose));
    expect(result.boundaries).toHaveLength(1);
    expect(result.boundaries[0]?.description).toBe(prose);
  });

  it("files schedule restrictions under SCHEDULING, from the question that asked", () => {
    const result = map(answer("scheduleRestrictions", "Never Sundays\nNo shoots before 11am"));
    expect(result.boundaries.map((b) => b.boundaryType)).toEqual(["SCHEDULING", "SCHEDULING"]);
    // Softer than a hard content limit: a schedule is negotiable, a limit is not.
    expect(result.boundaries.every((b) => b.severity === "SOFT")).toBe(true);
  });

  it("mirrors each hard NO into a prohibited truth item", () => {
    const result = map(answer("hardNos", "No feet content"));
    expect(result.truthItems).toEqual([
      expect.objectContaining({ itemType: "prohibited", statement: "No feet content" }),
    ]);
  });
});

describe("themes become pillars only when she wrote a list", () => {
  it("creates one pillar per listed theme", () => {
    const result = map(answer("themes", "Gym content\nCosplay\nGet ready with me"));
    expect(result.contentPillars.map((p) => p.name)).toEqual([
      "Gym content",
      "Cosplay",
      "Get ready with me",
    ]);
    expect(result.reviewNotes).toHaveLength(0);
  });

  it("refuses to cut a paragraph into pillars, and says a person must", () => {
    const result = map(
      answer(
        "themes",
        "I really enjoy making content around fitness and my day to day life, and I think my audience likes seeing the behind the scenes stuff more than anything polished.",
      ),
    );
    expect(result.contentPillars).toHaveLength(0);
    expect(result.reviewNotes.join(" ")).toMatch(/prose/i);
  });

  it("does not create two pillars with the same name", () => {
    // content_pillars carries unique(creator_id, name); a duplicate would make
    // the whole apply fail rather than skip one row.
    const result = map(answer("themes", "Cosplay\ncosplay\nGym"));
    expect(result.contentPillars.map((p) => p.name)).toEqual(["Cosplay", "Gym"]);
  });
});

describe("handles", () => {
  it("strips the decorations people put around a username", () => {
    const result = map(
      answer("instagram", "@sarahparks"),
      answer("tiktok", "https://tiktok.com/@sarah.parks"),
      answer("twitter", "sarahparks/"),
    );
    expect(result.socialHandles).toEqual([
      { provider: "INSTAGRAM", handle: "sarahparks" },
      { provider: "TIKTOK", handle: "sarah.parks" },
      { provider: "X", handle: "sarahparks" },
    ]);
  });

  it("produces no row for a platform she left blank", () => {
    expect(map(answer("instagram", "@sarahparks")).socialHandles).toHaveLength(1);
  });
});

describe("age and attestation", () => {
  it("reads a plain age", () => {
    const result = map(answer("age", "24"));
    expect(result.adult.reportedAge).toBe(24);
    expect(result.adult.belowMinimum).toBe(false);
  });

  it("flags a stated age below the line", () => {
    const result = map(answer("age", "17"), answer("adultConfirmation", "Yes"));
    expect(result.adult.belowMinimum).toBe(true);
    expect(intakeBlockers(result)).toContain("REPORTED_AGE_BELOW_MINIMUM");
  });

  /**
   * "unknown is not zero", applied to the sharpest case in the system: an
   * unreadable age must not read as underage OR as an adult. It is unknown, and
   * a human is told.
   */
  it("treats an unreadable age as unknown, not as underage", () => {
    const result = map(answer("age", "old enough"), answer("adultConfirmation", "Yes"));
    expect(result.adult.reportedAge).toBeNull();
    expect(result.adult.belowMinimum).toBe(false);
    expect(result.reviewNotes.join(" ")).toMatch(/Age could not be read/);
    expect(intakeBlockers(result)).not.toContain("REPORTED_AGE_BELOW_MINIMUM");
  });

  it("blocks a submission with no attestation, even with a valid age", () => {
    const result = map(answer("age", "24"), answer("referenceCode", "CR-000016-7KQ2"));
    expect(result.adult.attested).toBe(false);
    expect(intakeBlockers(result)).toContain("ADULT_ATTESTATION_MISSING");
  });

  it("passes a complete, adult, referenced submission", () => {
    const result = map(
      answer("referenceCode", "CR-000016-7KQ2"),
      answer("age", "24"),
      answer("adultConfirmation", "Yes"),
    );
    expect(intakeBlockers(result)).toEqual([]);
  });

  it("blocks when the reference code was cleared", () => {
    const result = map(answer("age", "24"), answer("adultConfirmation", "Yes"));
    expect(intakeBlockers(result)).toContain("NO_REFERENCE_CODE");
  });
});

describe("days per week", () => {
  it("reads a number", () => {
    expect(map(answer("daysPerWeek", "4")).brandProfile["content_days_per_week"]).toBe(4);
  });

  it("does not invent a number from an answer that has none", () => {
    const result = map(answer("daysPerWeek", "depends on the week"));
    expect("content_days_per_week" in result.brandProfile).toBe(false);
    expect(result.reviewNotes.join(" ")).toMatch(/could not be read as a number/);
  });

  it("refuses a value outside a week rather than storing it", () => {
    const result = map(answer("daysPerWeek", "20"));
    expect("content_days_per_week" in result.brandProfile).toBe(false);
    expect(result.reviewNotes).toHaveLength(1);
  });
});

describe("questions the mapper does not know", () => {
  /**
   * Somebody will add a question to the form and tell nobody. Silently
   * dropping it means a creator answers something and the answer evaporates.
   */
  it("preserves an unknown question instead of discarding it", () => {
    const result = mapIntakeSubmission({
      answers: [
        answer("persona", "Girl next door"),
        { itemId: 999999999, title: "Do you have a manager already?", values: ["No"] },
      ],
    });
    expect(result.unrecognized).toEqual([
      { itemId: 999999999, title: "Do you have a manager already?", values: ["No"] },
    ]);
    // ...and the rest of the submission still maps.
    expect(result.brandProfile["positioning_statement"]).toBe("Girl next door");
  });

  it("does not record an unknown question she left blank", () => {
    const result = mapIntakeSubmission({
      answers: [{ itemId: 999999999, title: "Anything else?", values: ["  "] }],
    });
    expect(result.unrecognized).toHaveLength(0);
  });
});

describe("re-applying a submission corrects rather than duplicates", () => {
  it("gives the same intake key for the same answer", () => {
    const first = map(answer("hardNos", "No feet content"));
    const second = map(answer("hardNos", "No feet content"));
    expect(first.boundaries[0]?.intakeKey).toBe(second.boundaries[0]?.intakeKey);
  });

  it("gives different keys to different answers", () => {
    const result = map(answer("hardNos", "No feet\nNo anal"));
    expect(result.boundaries[0]?.intakeKey).not.toBe(result.boundaries[1]?.intakeKey);
  });

  it("keeps the approved and prohibited keys apart for the same words", () => {
    const result = map(answer("contentComfort", "Feet"), answer("hardNos", "Feet"));
    const keys = result.truthItems.map((item) => item.intakeKey);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("the link a creator opens", () => {
  it("prefills the reference code into the field the live form actually has", () => {
    const url = composeIntakeUrl("CR-000016-7KQ2");
    expect(url).toContain("entry.583367904=CR-000016-7KQ2");
    expect(url).toContain("usp=pp_url");
  });

  it("shapes a code that reads as a reference number", () => {
    expect(composeReferenceCode("CR-000016", "7kq2")).toBe("CR-000016-7KQ2");
    expect(composeReferenceCode("CR-000016", "7k-q2xyz")).toBe("CR-000016-7KQ2");
  });
});

describe("her stated stage name never silently renames her", () => {
  /**
   * creators.stage_name is her identity in the system -- it names her Slack
   * channel, her Notion page and every task. A form answer must not rewrite it;
   * it is recorded for a person to compare.
   */
  it("returns the stated name separately rather than as a creator patch", () => {
    const result = map(answer("stageOrOnlyFansUsername", "sarahxo"));
    expect(result.statedStageName).toBe("sarahxo");
    expect(result.brandProfile).toEqual({});
  });
});
