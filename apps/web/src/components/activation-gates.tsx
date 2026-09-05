"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ADULT_CONFIRMATION_STATUSES,
  BOUNDARY_SEVERITIES,
  BOUNDARY_TYPES,
  JURISDICTION_REVIEW_STATUSES,
  CONTRACT_STATUSES,
  hasRealTimezone,
} from "@creatoros/domain";

export interface TeamMember {
  id: string;
  name: string;
}

/**
 * The controls that clear the activation gates, on the creator they gate.
 *
 * Every one of these decisions was previously unrecordable: the conversion RPC
 * inserts a creator at PENDING/NOT_STARTED with no owners and no boundaries,
 * and nothing in the product could change any of it. Activation was therefore
 * unreachable without direct database access.
 *
 * They are grouped here rather than scattered across the page because they
 * share one job -- getting a creator to ACTIVE -- and because the readiness
 * panel directly above lists exactly which of them are still outstanding.
 */
export function ActivationGates({
  creatorId,
  updatedAt,
  jurisdictionReviewStatus,
  adultConfirmationStatus,
  contractStatus,
  timezone,
  assignedCreatorSuccessUserId,
  assignedGrowthUserId,
  team,
  boundaryCount,
  baselineFrozen,
}: {
  creatorId: string;
  updatedAt: string;
  jurisdictionReviewStatus: string | null;
  adultConfirmationStatus: string | null;
  contractStatus: string | null;
  timezone: string | null;
  assignedCreatorSuccessUserId: string | null;
  assignedGrowthUserId: string | null;
  team: TeamMember[];
  boundaryCount: number;
  baselineFrozen: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const router = useRouter();

  async function send(label: string, path: string, body: Record<string, unknown>) {
    setBusy(label);
    setMessage(null);
    try {
      const response = await fetch(path, {
        method: path.endsWith("/boundaries") || path.endsWith("/baseline") ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        if (response.status === 409 && payload.error === "CREATOR_CHANGED_REFRESH_REQUIRED")
          throw new Error("Someone else changed this creator first. Refresh and try again.");
        if (payload.error === "NO_MEASURED_DATA_IN_PERIOD")
          throw new Error("No measured data in that period. Import revenue for it first.");
        throw new Error(payload.error ?? `Request failed (${response.status})`);
      }
      // Re-read from the server so the concurrency token and the readiness
      // panel both reflect committed state rather than an optimistic guess.
      startTransition(() => router.refresh());
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Update failed");
    } finally {
      setBusy(null);
    }
  }

  const base = `/api/creators/${creatorId}`;

  return (
    <section className="card card-pad">
      <h2>Activation gates</h2>
      <p className="subtitle" style={{ marginTop: 6, lineHeight: 1.6 }}>
        Decisions CreatorOS will not make for you. Each one is recorded against this creator and
        audited to the person who made it.
      </p>

      {message ? (
        <p role="alert" style={{ color: "var(--red)", fontSize: 11, marginTop: 10 }}>
          {message}
        </p>
      ) : null}

      <div style={{ display: "grid", gap: 14, marginTop: 14 }}>
        <label style={{ display: "grid", gap: 4, fontSize: 11 }}>
          <span className="eyebrow">CONTRACT</span>
          <select
            className="input"
            value={contractStatus ?? "PENDING"}
            disabled={busy !== null}
            onChange={(event) =>
              void send("contract", base, { contractStatus: event.target.value, updatedAt })
            }
          >
            {CONTRACT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
          <span style={{ fontSize: 9.5, color: "var(--ink-soft)" }}>
            Only SIGNED or ACTIVE clears the activation gate. Move this when the
            agreement is actually signed, not before.
          </span>
        </label>

        <label style={{ display: "grid", gap: 4, fontSize: 11 }}>
          <span className="eyebrow">CREATOR TIMEZONE</span>
          <input
            className="input"
            defaultValue={hasRealTimezone(timezone) ? (timezone ?? "") : ""}
            placeholder="America/Los_Angeles"
            disabled={busy !== null}
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (value === "" || value === timezone) return;
              void send("timezone", base, { timezone: value, updatedAt });
            }}
          />
          <span style={{ fontSize: 9.5, color: "var(--ink-soft)" }}>
            {hasRealTimezone(timezone)
              ? "Their daily report is dated in this zone."
              : "Not set. Reports fall back to UTC, which will be the wrong day for most creators."}
          </span>
        </label>

        <label style={{ display: "grid", gap: 4, fontSize: 11 }}>
          <span className="eyebrow">JURISDICTION REVIEW</span>
          <select
            className="input"
            value={jurisdictionReviewStatus ?? "PENDING"}
            disabled={busy !== null}
            onChange={(event) =>
              void send("jurisdiction", base, {
                jurisdictionReviewStatus: event.target.value,
                updatedAt,
              })
            }
          >
            {JURISDICTION_REVIEW_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "grid", gap: 4, fontSize: 11 }}>
          <span className="eyebrow">ADULT CONFIRMATION</span>
          <select
            className="input"
            value={adultConfirmationStatus ?? "NOT_STARTED"}
            disabled={busy !== null}
            onChange={(event) =>
              void send("adult", base, {
                adultConfirmationStatus: event.target.value,
                updatedAt,
              })
            }
          >
            {ADULT_CONFIRMATION_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "grid", gap: 4, fontSize: 11 }}>
          <span className="eyebrow">CREATOR SUCCESS OWNER</span>
          <select
            className="input"
            value={assignedCreatorSuccessUserId ?? ""}
            disabled={busy !== null}
            onChange={(event) =>
              void send("cs-owner", base, {
                creatorSuccessUserId: event.target.value === "" ? null : event.target.value,
                updatedAt,
              })
            }
          >
            <option value="">Unassigned</option>
            {team.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "grid", gap: 4, fontSize: 11 }}>
          <span className="eyebrow">GROWTH OWNER</span>
          <select
            className="input"
            value={assignedGrowthUserId ?? ""}
            disabled={busy !== null}
            onChange={(event) =>
              void send("growth-owner", base, {
                growthUserId: event.target.value === "" ? null : event.target.value,
                updatedAt,
              })
            }
          >
            <option value="">Unassigned</option>
            {team.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </label>

        <IntakeLinkControl creatorId={creatorId} />

        <BoundaryForm
          busy={busy !== null}
          count={boundaryCount}
          onSubmit={(boundary) => send("boundary", `${base}/boundaries`, boundary)}
        />

        <BaselineForm
          busy={busy !== null}
          frozen={baselineFrozen}
          onSubmit={(period) => send("baseline", `${base}/baseline`, period)}
        />
      </div>
    </section>
  );
}

function BoundaryForm({
  busy,
  count,
  onSubmit,
}: {
  busy: boolean;
  count: number;
  onSubmit: (boundary: Record<string, unknown>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [boundaryType, setBoundaryType] = useState<string>(BOUNDARY_TYPES[0]);
  const [severity, setSeverity] = useState<string>(BOUNDARY_SEVERITIES[0]);
  const [description, setDescription] = useState("");

  if (!open)
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span style={{ fontSize: 11 }}>
          <span className="eyebrow">BOUNDARIES</span>{" "}
          <span style={{ color: "var(--ink-soft)" }}>
            {count === 0 ? "None recorded — activation is blocked" : `${count} recorded`}
          </span>
        </span>
        <button type="button" className="button" onClick={() => setOpen(true)} disabled={busy}>
          Add boundary
        </button>
      </div>
    );

  return (
    <form
      style={{ display: "grid", gap: 8, borderTop: "1px solid var(--rule)", paddingTop: 12 }}
      onSubmit={(event) => {
        event.preventDefault();
        if (description.trim().length === 0) return;
        void onSubmit({
          boundaryType,
          severity,
          description: description.trim(),
          requiresCreatorApproval: severity === "SOFT",
        }).then(() => {
          setDescription("");
          setOpen(false);
        });
      }}
    >
      <span className="eyebrow">NEW BOUNDARY</span>
      <select
        className="input"
        aria-label="Boundary type"
        value={boundaryType}
        onChange={(event) => setBoundaryType(event.target.value)}
      >
        {BOUNDARY_TYPES.map((type) => (
          <option key={type} value={type}>
            {type}
          </option>
        ))}
      </select>
      <select
        className="input"
        aria-label="Severity"
        value={severity}
        onChange={(event) => setSeverity(event.target.value)}
      >
        {BOUNDARY_SEVERITIES.map((level) => (
          <option key={level} value={level}>
            {level === "HARD" ? "HARD — never" : "SOFT — case by case"}
          </option>
        ))}
      </select>
      <input
        className="input"
        aria-label="Boundary description"
        placeholder="What the creator will not do"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        maxLength={2000}
      />
      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" className="button primary" disabled={busy}>
          Record boundary
        </button>
        <button type="button" className="button" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function BaselineForm({
  busy,
  frozen,
  onSubmit,
}: {
  busy: boolean;
  frozen: boolean;
  onSubmit: (period: Record<string, unknown>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");

  if (!open)
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span style={{ fontSize: 11 }}>
          <span className="eyebrow">BASELINE</span>{" "}
          <span style={{ color: "var(--ink-soft)" }}>
            {frozen ? "Frozen" : "Not frozen — no report can be produced"}
          </span>
        </span>
        <button type="button" className="button" onClick={() => setOpen(true)} disabled={busy}>
          {frozen ? "Re-freeze" : "Freeze baseline"}
        </button>
      </div>
    );

  return (
    <form
      style={{ display: "grid", gap: 8, borderTop: "1px solid var(--rule)", paddingTop: 12 }}
      onSubmit={(event) => {
        event.preventDefault();
        if (!periodStart || !periodEnd) return;
        void onSubmit({ periodStart, periodEnd }).then(() => setOpen(false));
      }}
    >
      <span className="eyebrow">FREEZE FROM MEASURED PERIOD</span>
      <p className="subtitle" style={{ fontSize: 10.5, lineHeight: 1.5 }}>
        Computed from imported figures over this period, never typed. Import revenue for the period
        first, or this is refused rather than frozen at zero.
      </p>
      <label style={{ display: "grid", gap: 3, fontSize: 10.5 }}>
        Period start
        <input
          className="input"
          type="date"
          value={periodStart}
          onChange={(event) => setPeriodStart(event.target.value)}
          required
        />
      </label>
      <label style={{ display: "grid", gap: 3, fontSize: 10.5 }}>
        Period end
        <input
          className="input"
          type="date"
          value={periodEnd}
          onChange={(event) => setPeriodEnd(event.target.value)}
          required
        />
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" className="button primary" disabled={busy}>
          Freeze
        </button>
        <button type="button" className="button" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * Mints the link the creator opens to fill in her Model Information Sheet.
 *
 * It sits among the gates because that is what it feeds: her boundaries clear
 * the boundaries gate, and her answers fill the brand profile and content
 * pillars that activation otherwise creates empty.
 *
 * The link is shown rather than sent. On Slack's free plan a creator cannot be
 * put in a Slack Connect channel at all, so there is no channel to post it to —
 * the operator copies it and sends it however they already talk to her.
 */
function IntakeLinkControl({ creatorId }: { creatorId: string }) {
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ url: string; referenceCode: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  async function issue() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/creators/${creatorId}/intake-link`, { method: "POST" });
      const body = (await response.json()) as {
        url?: string;
        referenceCode?: string;
        error?: string;
      };
      if (!response.ok || !body.url || !body.referenceCode) {
        setError(body.error ?? "Could not issue an intake link");
        return;
      }
      setLink({ url: body.url, referenceCode: body.referenceCode });
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      // Clipboard access is denied in some contexts; the URL is on screen and
      // selectable, so this is a downgrade rather than a failure.
      setCopied(false);
      setError("Could not copy automatically — select the link below instead.");
    }
  }

  return (
    <div style={{ display: "grid", gap: 6, fontSize: 11 }}>
      <span className="eyebrow">MODEL INFORMATION SHEET</span>
      {error ? (
        <p role="alert" style={{ color: "var(--red)", fontSize: 11 }}>
          {error}
        </p>
      ) : null}
      {link ? (
        <>
          <p style={{ fontSize: 10.5, color: "var(--ink-soft)" }}>
            Reference code <strong>{link.referenceCode}</strong>. Send her this link — the code is
            filled in for her.
          </p>
          <input className="input" readOnly value={link.url} onFocus={(e) => e.target.select()} />
          <div className="actions">
            <button className="button" type="button" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy link"}
            </button>
            <button className="button" type="button" disabled={busy} onClick={() => void issue()}>
              Issue a new one
            </button>
          </div>
        </>
      ) : (
        <>
          <button className="button" type="button" disabled={busy} onClick={() => void issue()}>
            {busy ? "Issuing…" : "Issue intake link"}
          </button>
          <span style={{ fontSize: 9.5, color: "var(--ink-soft)" }}>
            Her answers arrive in Intake review. Nothing is written to her record until you apply
            them.
          </span>
        </>
      )}
    </div>
  );
}
