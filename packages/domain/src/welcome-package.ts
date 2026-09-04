import type { DataConfidence, MetricPoint } from "./types";

/**
 * The document a creator reads on day one.
 *
 * Until now `GENERATE_WELCOME_PACKAGE` created a task titled "Send welcome
 * package to X" — a reminder to the operator, not an artifact. This composes
 * the actual thing, from data CreatorOS already holds.
 *
 * WHY IT REFUSES TO INVENT. This is the first output a creator judges Foundry
 * on, and the people being onboarded are often older and more experienced than
 * the person onboarding them. The instinct in that position is to lead with
 * confidence — projections, promises, round numbers. It is exactly the wrong
 * move, because an experienced creator has seen those before and discounts
 * them. What she has probably never had is an agency that says "here is what we
 * measured, here is what we do not know yet, and here is what we will not do."
 *
 * So: every figure here traces to a frozen baseline or a stated boundary. When
 * the baseline is missing, the package SAYS the baseline is missing rather than
 * estimating one. An absent measurement is a sentence, not a number.
 */

export interface WelcomePackageInput {
  stageName: string;
  /** Foundry people who will be in the creator's Slack channel. */
  team: ReadonlyArray<{ name: string; role: string }>;
  /** The measured starting point, or null when nothing has been frozen. */
  baseline: {
    metrics: MetricPoint;
    periodStart: string;
    periodEnd: string;
    /** Dimensions the freeze recorded as never measured. */
    unmeasuredDimensions: readonly string[];
    dataConfidence: DataConfidence;
  } | null;
  /** What the creator said they will not do, in their words. */
  boundaries: ReadonlyArray<{ boundaryType: string; description: string; severity: string }>;
  /** First-30-day commitments, from the tasks activation created. */
  commitments: ReadonlyArray<{ title: string; owner: string; dueAt: string | null }>;
  /** Commission rate as a fraction, e.g. 0.35. Null when not recorded. */
  commissionRate: number | null;
  reportingCadence: "DAILY" | "WEEKLY" | null;
  creatorTimezone: string | null;
}

export interface WelcomeSection {
  heading: string;
  body: string[];
  /**
   * Present when this section could not be filled from measured data. The
   * section still renders — the gap is the message.
   */
  missing?: string;
}

export interface WelcomePackage {
  stageName: string;
  sections: WelcomeSection[];
  /** True when every section had real data behind it. */
  complete: boolean;
  /** What must exist before this package is worth sending. */
  blockingGaps: string[];
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatRate(numerator: number, denominator: number): string | null {
  if (denominator <= 0 || numerator <= 0) return null;
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

/**
 * Composes the package.
 *
 * Returns sections rather than a rendered string so the same content can become
 * a Notion page, an email, or a Slack post without three copies of the wording
 * drifting apart.
 */
export function composeWelcomePackage(input: WelcomePackageInput): WelcomePackage {
  const sections: WelcomeSection[] = [];
  const blockingGaps: string[] = [];

  // 1. Who the creator is actually working with.
  sections.push({
    heading: "Your Foundry team",
    body:
      input.team.length > 0
        ? input.team.map((member) => `${member.name} — ${member.role}`)
        : [],
    ...(input.team.length === 0
      ? { missing: "No Foundry owner has been assigned yet." }
      : {}),
  });
  if (input.team.length === 0) blockingGaps.push("Assign a Foundry owner");

  // 2. The measured starting point. The credibility section.
  if (input.baseline) {
    const { metrics, periodStart, periodEnd, unmeasuredDimensions } = input.baseline;
    const unmeasured = new Set(unmeasuredDimensions);
    const lines = [
      `Measured ${periodStart} to ${periodEnd}. Confidence: ${input.baseline.dataConfidence}.`,
      `Revenue: ${formatMoney(metrics.revenue)}`,
      `New subscribers: ${metrics.newSubscribers.toLocaleString("en-US")}`,
      `First-time buyers: ${metrics.firstBuyers.toLocaleString("en-US")}`,
    ];

    const buyRate = formatRate(metrics.firstBuyers, metrics.newSubscribers);
    if (buyRate) lines.push(`Of the people who subscribed, ${buyRate} bought something.`);

    /**
     * Named individually rather than folded into a footnote. A creator reading
     * "reach: 0" would reasonably conclude her content reached nobody; the
     * truth is that Foundry has not ingested it yet, and saying so is the
     * difference between an honest gap and an accidental insult.
     */
    const notMeasured = ["reach", "profileVisits", "outboundClicks"].filter((d) =>
      unmeasured.has(d),
    );
    if (notMeasured.length > 0)
      lines.push(
        `Not yet measured: ${notMeasured.join(", ")}. These are absent from our records, not zero — we start collecting them now.`,
      );

    sections.push({ heading: "Where you are starting from", body: lines });
  } else {
    sections.push({
      heading: "Where you are starting from",
      body: [],
      missing:
        "We have not measured your baseline yet. We will not put a number in front of you that we have not measured — this section fills in once we have your first 30 days.",
    });
    blockingGaps.push("Freeze a baseline");
  }

  // 3. Their boundaries, read back to them.
  sections.push({
    heading: "What we will not do",
    body:
      input.boundaries.length > 0
        ? input.boundaries.map(
            (boundary) => `${boundary.description} (${boundary.boundaryType}, ${boundary.severity})`,
          )
        : [],
    ...(input.boundaries.length === 0
      ? { missing: "No boundaries recorded yet. We will not begin work until these are captured." }
      : {}),
  });
  if (input.boundaries.length === 0) blockingGaps.push("Record creator boundaries");

  // 4. The first thirty days, with owners.
  sections.push({
    heading: "Your first 30 days",
    body: input.commitments.map(
      (commitment) =>
        `${commitment.title} — ${commitment.owner}${commitment.dueAt ? `, by ${commitment.dueAt}` : ""}`,
    ),
    ...(input.commitments.length === 0
      ? { missing: "No commitments scheduled yet." }
      : {}),
  });

  // 5. How they will know it is working.
  const reporting: string[] = [];
  if (input.reportingCadence) {
    reporting.push(
      `You get a ${input.reportingCadence.toLowerCase()} report${
        input.creatorTimezone ? `, dated in ${input.creatorTimezone}` : ""
      }.`,
    );
    reporting.push(
      "Every figure in it is compared against your own baseline, never against other creators.",
    );
    reporting.push(
      "Anything we have not measured is reported as unmeasured rather than as a zero.",
    );
  }
  sections.push({
    heading: "How you will know it is working",
    body: reporting,
    ...(input.reportingCadence === null
      ? { missing: "No reporting schedule set up yet." }
      : {}),
  });

  // 6. Commercial terms, stated plainly.
  sections.push({
    heading: "Our arrangement",
    body:
      input.commissionRate === null
        ? []
        : [
            `Foundry takes ${(input.commissionRate * 100).toFixed(0)}% of your platform receipts.`,
            "You keep ownership of your account, your content, and your audience.",
          ],
    ...(input.commissionRate === null
      ? { missing: "Commission rate not recorded. Do not send this without it." }
      : {}),
  });
  if (input.commissionRate === null) blockingGaps.push("Record the commission rate");

  return {
    stageName: input.stageName,
    sections,
    complete: sections.every((section) => section.missing === undefined),
    blockingGaps,
  };
}

/** Renders the package as Markdown, for a Notion page or an email. */
export function renderWelcomePackage(pkg: WelcomePackage): string {
  const lines = [`# Welcome to Foundry, ${pkg.stageName}`, ""];
  for (const section of pkg.sections) {
    lines.push(`## ${section.heading}`, "");
    if (section.missing) {
      lines.push(`_${section.missing}_`, "");
      continue;
    }
    for (const item of section.body) lines.push(`- ${item}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
