"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Link2, X } from "lucide-react";
import type { IntakeSubmissionSummary } from "@/lib/creator-intake";
import { StatusBadge } from "@/components/status-badge";

/**
 * The review surface for one creator's intake.
 *
 * Its job is to make the consequence of clicking Apply legible BEFORE it is
 * clicked. Everything that would be written is listed in the words the creator
 * used, because these are her boundaries and her limits, and an operator
 * approving a summary of them is approving something different from the thing
 * that gets stored.
 */

const BLOCKER_COPY: Record<string, string> = {
  NO_REFERENCE_CODE:
    "No reference code, so this cannot be tied to a creator automatically. Match it below.",
  ADULT_ATTESTATION_MISSING:
    "She did not tick the 18+ confirmation. This cannot be applied without it.",
  REPORTED_AGE_BELOW_MINIMUM:
    "The age given is below 18. Do not apply this. Stop and speak to her.",
};

export function IntakeReviewList({
  submissions,
  creators,
}: {
  submissions: IntakeSubmissionSummary[];
  creators: Array<{ id: string; label: string }>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  async function act(submissionId: string, body: Record<string, unknown>) {
    setBusy(submissionId);
    setMessage("");
    try {
      const response = await fetch(`/api/intake/${submissionId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const parsed = (await response.json()) as { error?: string };
      if (!response.ok) {
        // The server's own reason, not a generic one: INTAKE_BLOCKED names
        // which blocker stopped it, and hiding that would leave the operator
        // clicking a button that keeps failing for no stated reason.
        setMessage(parsed.error ?? "Intake action failed");
        return;
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid" style={{ gap: 18 }}>
      {message ? (
        <div className="demo-strip" role="alert">
          {message}
        </div>
      ) : null}

      {submissions.map((submission) => {
        const { mapped } = submission;
        const approved = mapped.truthItems.filter((item) => item.itemType === "approved");
        const prohibited = mapped.truthItems.filter((item) => item.itemType === "prohibited");
        const decided = submission.status === "APPLIED" || submission.status === "REJECTED";
        const brandKeys = Object.keys(mapped.brandProfile);

        return (
          <article className="card card-pad" key={submission.id}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 18,
                alignItems: "flex-start",
                flexWrap: "wrap",
              }}
            >
              <div>
                <div className="eyebrow">
                  {new Date(submission.submittedAt).toLocaleString()} ·{" "}
                  {submission.referenceCodeSubmitted ?? "no reference code"}
                </div>
                <h2 style={{ fontFamily: "Georgia,serif", fontSize: 23, marginTop: 4 }}>
                  {submission.creatorName ?? "Unmatched submission"}
                </h2>
                <StatusBadge value={submission.status} />
                {submission.respondentEmail ? (
                  <p className="subtitle" style={{ marginTop: 6 }}>
                    Submitted by {submission.respondentEmail}
                  </p>
                ) : null}
              </div>

              {decided ? (
                <p className="subtitle">
                  {submission.status === "APPLIED" ? "Applied" : "Rejected"}
                  {submission.appliedAt
                    ? ` ${new Date(submission.appliedAt).toLocaleString()}`
                    : ""}
                  {submission.errorMessage ? ` — ${submission.errorMessage}` : ""}
                </p>
              ) : (
                <div className="actions">
                  <button
                    className="button primary"
                    disabled={busy !== null || submission.blockers.length > 0}
                    onClick={() => void act(submission.id, { action: "apply" })}
                  >
                    <Check size={14} /> Apply to creator
                  </button>
                  <button
                    className="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void act(submission.id, {
                        action: "reject",
                        reason: "Rejected on review",
                      })
                    }
                  >
                    <X size={14} /> Reject
                  </button>
                </div>
              )}
            </div>

            {submission.blockers.length > 0 ? (
              <div style={{ marginTop: 14 }}>
                {submission.blockers.map((blocker) => (
                  <p
                    key={blocker}
                    role="alert"
                    style={{
                      color: "var(--red)",
                      fontSize: 12,
                      display: "flex",
                      gap: 8,
                      alignItems: "flex-start",
                      marginTop: 6,
                    }}
                  >
                    <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                    {BLOCKER_COPY[blocker] ?? blocker}
                  </p>
                ))}
              </div>
            ) : null}

            {submission.status === "UNMATCHED" && !decided ? (
              <MatchControl
                busy={busy === submission.id}
                creators={creators}
                onMatch={(creatorId) => void act(submission.id, { action: "match", creatorId })}
              />
            ) : null}

            <div className="grid detail-grid" style={{ marginTop: 18 }}>
              <Section title="WILL NOT DO" empty="No boundaries stated.">
                {mapped.boundaries.map((boundary) => (
                  <p className="subtitle" style={{ marginTop: 6 }} key={boundary.intakeKey}>
                    • {boundary.description}{" "}
                    <span style={{ opacity: 0.65 }}>
                      ({boundary.boundaryType}, {boundary.severity})
                    </span>
                  </p>
                ))}
                {prohibited.map((item) => (
                  <p className="subtitle" style={{ marginTop: 6 }} key={item.intakeKey}>
                    • {item.statement} <span style={{ opacity: 0.65 }}>(prohibited)</span>
                  </p>
                ))}
              </Section>

              <Section title="COMFORTABLE WITH" empty="Nothing ticked.">
                {approved.map((item) => (
                  <p className="subtitle" style={{ marginTop: 6 }} key={item.intakeKey}>
                    • {item.statement}
                  </p>
                ))}
                {/* Said explicitly, because a short list here is the single
                    easiest thing to misread as a list of refusals. */}
                {approved.length > 0 ? (
                  <p className="subtitle" style={{ marginTop: 10, opacity: 0.7, fontSize: 11 }}>
                    Anything not listed was left unticked. That is not a refusal — only the
                    boundaries above are.
                  </p>
                ) : null}
              </Section>

              <Section title="PROFILE" empty="Nothing to write.">
                {brandKeys.map((key) => {
                  const value = mapped.brandProfile[key];
                  return (
                    <p className="subtitle" style={{ marginTop: 6 }} key={key}>
                      • <strong>{key.replace(/_/g, " ")}</strong>:{" "}
                      {/* Arrays are real here (languages is text[]), and
                          String([...]) renders "English,Spanish" with no space. */}
                      {Array.isArray(value) ? value.join(", ") : String(value)}
                    </p>
                  );
                })}
                {mapped.contentPillars.length > 0 ? (
                  <p className="subtitle" style={{ marginTop: 6 }}>
                    • <strong>pillars</strong>:{" "}
                    {mapped.contentPillars.map((pillar) => pillar.name).join(", ")}
                  </p>
                ) : null}
                {mapped.socialHandles.map((handle) => (
                  <p className="subtitle" style={{ marginTop: 6 }} key={handle.provider}>
                    • <strong>{handle.provider.toLowerCase()}</strong>: @{handle.handle}
                  </p>
                ))}
              </Section>
            </div>

            <p className="subtitle" style={{ marginTop: 14, fontSize: 12 }}>
              Age:{" "}
              {mapped.adult.reportedAge !== null
                ? mapped.adult.reportedAge
                : mapped.adult.rawAge
                  ? `not a number — "${mapped.adult.rawAge}"`
                  : "not given"}{" "}
              · 18+ confirmation {mapped.adult.attested ? "ticked" : "NOT ticked"}
              {mapped.statedStageName ? ` · she wrote "${mapped.statedStageName}" as her name` : ""}
            </p>

            {mapped.reviewNotes.length > 0 || mapped.unrecognized.length > 0 ? (
              <div style={{ marginTop: 12 }}>
                {mapped.reviewNotes.map((note) => (
                  <p className="subtitle" style={{ marginTop: 6, fontSize: 12 }} key={note}>
                    ⚠ {note}
                  </p>
                ))}
                {mapped.unrecognized.length > 0 ? (
                  <p className="subtitle" style={{ marginTop: 6, fontSize: 12 }}>
                    ⚠ {mapped.unrecognized.length} answer
                    {mapped.unrecognized.length === 1 ? "" : "s"} to questions CreatorOS does not
                    know. Someone added a question to the form — her answer is stored but nothing
                    will be written from it.
                  </p>
                ) : null}
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function Section({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode;
}) {
  const hasContent = Array.isArray(children)
    ? children.some((child) => Array.isArray(child) ? child.length > 0 : Boolean(child))
    : Boolean(children);
  return (
    <div>
      <span className="eyebrow">{title}</span>
      {hasContent ? (
        children
      ) : (
        <p className="subtitle" style={{ marginTop: 6 }}>
          {empty}
        </p>
      )}
    </div>
  );
}

/**
 * The recovery path for the one thing an editable prefill guarantees will
 * happen: she clears or mistypes the reference code. Her email usually makes
 * the match obvious, and an operator asserting it is a better record than a
 * fuzzy match the system guessed at.
 */
function MatchControl({
  busy,
  creators,
  onMatch,
}: {
  busy: boolean;
  creators: Array<{ id: string; label: string }>;
  onMatch: (creatorId: string) => void;
}) {
  const [creatorId, setCreatorId] = useState("");
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center", flexWrap: "wrap" }}>
      <Link2 size={14} />
      <select
        className="input"
        style={{ maxWidth: 320 }}
        value={creatorId}
        disabled={busy}
        onChange={(event) => setCreatorId(event.target.value)}
      >
        <option value="">Match to a creator…</option>
        {creators.map((creator) => (
          <option key={creator.id} value={creator.id}>
            {creator.label}
          </option>
        ))}
      </select>
      <button
        className="button"
        disabled={busy || creatorId === ""}
        onClick={() => onMatch(creatorId)}
      >
        Match
      </button>
    </div>
  );
}
