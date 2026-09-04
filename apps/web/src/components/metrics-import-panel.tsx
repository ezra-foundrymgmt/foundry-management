"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DATA_CONFIDENCES, SOCIAL_PLATFORMS } from "@creatoros/domain";

/**
 * The operator surface for both ingestion paths.
 *
 * `importCreatorRevenue` shipped with an API route and no caller anywhere in
 * the product, so the only way to get a figure into CreatorOS was curl — while
 * the activation checklist told the operator to "import 30-day baseline
 * figures". Adding a second API-only path would have produced two ingestion
 * routes and no way to reach either.
 *
 * A row list rather than a paste-a-CSV box, deliberately. There is no CSV to
 * paste from: Instagram and TikTok insights are read off a screen, and a
 * delimited parser is precisely where a blank cell silently becomes a zero.
 * Here a blank field stays blank and is sent as null, which the API reads as
 * "not measured" rather than "measured zero".
 */

type Mode = "revenue" | "social";

const MESSAGES: Record<string, string> = {
  INVALID_INPUT: "Check the highlighted fields before saving.",
  CREATOR_NOT_FOUND: "That creator is not in this organization.",
  PERMISSION_DENIED: "Importing measurements requires creator or finance permissions.",
  AUTHENTICATION_REQUIRED: "Your session expired. Sign in again.",
  DATABASE_NOT_CONFIGURED: "The live database is not configured in this environment.",
  DUPLICATE_DATES_IN_PAYLOAD: "Two rows have the same date. Each day may appear once.",
  DUPLICATE_POST_IDS_IN_PAYLOAD: "Two rows have the same post id. Each post may appear once.",
  MEASURED_BEFORE_PUBLISHED: "A post cannot be measured before it was published.",
  REVENUE_IMPORT_FAILED: "Something went wrong. Reload before retrying.",
  SOCIAL_IMPORT_FAILED: "Something went wrong. Reload before retrying.",
  METRICS_IMPORT_DATABASE_FAILED: "The figures could not be saved. Nothing changed.",
  SOCIAL_IMPORT_DATABASE_FAILED: "The figures could not be saved. Nothing changed.",
};

/**
 * A blank field is not zero.
 *
 * `Number("")` is 0 and `parseInt("")` is NaN, so either careless conversion
 * turns "I did not read this metric" into a measurement of zero — which then
 * gets summed into a report and frozen into a baseline.
 */
function numberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

const SOCIAL_METRICS = [
  ["views", "Views"],
  ["reach", "Reach"],
  ["impressions", "Impressions"],
  ["likes", "Likes"],
  ["comments", "Comments"],
  ["shares", "Shares"],
  ["saves", "Saves"],
  ["profileVisits", "Profile visits"],
  ["outboundClicks", "Outbound clicks"],
  ["followsGenerated", "Follows"],
] as const;

const REVENUE_METRICS = [
  ["creatorPlatformReceipts", "Receipts"],
  ["newSubscribers", "New subs"],
  ["firstBuyers", "First buyers"],
  ["activeSubscribers", "Active subs"],
  ["payingFans", "Paying fans"],
] as const;

interface RowState {
  key: string;
  /** date for revenue; externalPostId for social. */
  identity: string;
  publishedAt: string;
  values: Record<string, string>;
}

function blankRow(index: number): RowState {
  return { key: `row-${index}`, identity: "", publishedAt: "", values: {} };
}

export function MetricsImportPanel({
  creatorId,
  canImportRevenue,
  canImportSocial,
}: {
  creatorId: string;
  canImportRevenue: boolean;
  canImportSocial: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>(canImportSocial ? "social" : "revenue");
  const [platform, setPlatform] = useState<string>(SOCIAL_PLATFORMS[0]);
  const [revenuePlatform, setRevenuePlatform] = useState("ONLYFANS");
  const [source, setSource] = useState("OPERATOR_ENTRY");
  /**
   * Starts at UNKNOWN, not MEASURED. Defaulting to the strongest claim means
   * an operator who never touches the control has silently asserted that every
   * figure was measured — and that assertion now propagates into the
   * confidence stamped on any recommendation built from it.
   */
  const [confidence, setConfidence] = useState<string>("UNKNOWN");
  const [measuredAt, setMeasuredAt] = useState("");
  const [rows, setRows] = useState<RowState[]>([blankRow(0)]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [ok, setOk] = useState("");
  const [, startTransition] = useTransition();
  const router = useRouter();

  const metrics = mode === "social" ? SOCIAL_METRICS : REVENUE_METRICS;

  function setValue(rowKey: string, field: string, value: string) {
    setRows((current) =>
      current.map((row) =>
        row.key === rowKey ? { ...row, values: { ...row.values, [field]: value } } : row,
      ),
    );
  }

  function setIdentity(rowKey: string, value: string) {
    setRows((current) =>
      current.map((row) => (row.key === rowKey ? { ...row, identity: value } : row)),
    );
  }

  function setPublished(rowKey: string, value: string) {
    setRows((current) =>
      current.map((row) => (row.key === rowKey ? { ...row, publishedAt: value } : row)),
    );
  }

  function reset() {
    setRows([blankRow(0)]);
    setMessage("");
  }

  async function submit() {
    setBusy(true);
    setMessage("");
    setOk("");

    const filled = rows.filter((row) => row.identity.trim() !== "");
    if (filled.length === 0) {
      setMessage("Add at least one row before importing.");
      setBusy(false);
      return;
    }

    const endpoint =
      mode === "social"
        ? `/api/creators/${creatorId}/social`
        : `/api/creators/${creatorId}/revenue`;

    const body =
      mode === "social"
        ? {
            platform,
            source: source.trim(),
            dataConfidence: confidence,
            rows: filled.map((row) => ({
              externalPostId: row.identity.trim(),
              publishedAt: new Date(`${row.publishedAt}T12:00:00Z`).toISOString(),
              measuredAt: measuredAt === "" ? null : new Date(`${measuredAt}T12:00:00Z`).toISOString(),
              format: null,
              hookLabel: null,
              captionSummary: null,
              durationSeconds: null,
              // Every metric key is sent explicitly. The API requires them, so
              // that a partial re-import cannot silently null a figure an
              // earlier fuller import had measured.
              ...Object.fromEntries(
                SOCIAL_METRICS.map(([field]) => [field, numberOrNull(row.values[field] ?? "")]),
              ),
            })),
          }
        : {
            platform: revenuePlatform.trim(),
            source: source.trim(),
            dataConfidence: confidence,
            rows: filled.map((row) => ({
              date: row.identity.trim(),
              ...Object.fromEntries(
                REVENUE_METRICS.map(([field]) => [field, numberOrNull(row.values[field] ?? "")]),
              ),
            })),
          };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      data?: { rowsWritten: number };
      error?: string;
    };
    setBusy(false);

    if (!response.ok || !payload.data) {
      setMessage(
        (payload.error && MESSAGES[payload.error]) ??
          "The figures could not be saved. Nothing changed.",
      );
      return;
    }
    setOk(`Imported ${payload.data.rowsWritten} ${mode === "social" ? "posts" : "days"}.`);
    reset();
    startTransition(() => router.refresh());
  }

  if (!canImportRevenue && !canImportSocial) return null;

  if (!open)
    return (
      <button className="button" onClick={() => setOpen(true)}>
        Import measurements
      </button>
    );

  return (
    <section className="card card-pad" style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <strong style={{ fontSize: 12 }}>Import measurements</strong>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          {canImportSocial ? (
            <button
              className={mode === "social" ? "button primary" : "button"}
              onClick={() => setMode("social")}
            >
              Social posts
            </button>
          ) : null}
          {canImportRevenue ? (
            <button
              className={mode === "revenue" ? "button primary" : "button"}
              onClick={() => setMode("revenue")}
            >
              Revenue
            </button>
          ) : null}
        </div>
      </div>

      <p className="subtitle" style={{ fontSize: 10, margin: 0, lineHeight: 1.5 }}>
        Leave a metric blank if you did not read it. A blank is recorded as not
        measured, which is different from a measured zero and is treated
        differently by every report.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        <label style={{ display: "grid", gap: 3, fontSize: 10.5 }}>
          Platform
          {mode === "social" ? (
            <select
              className="input"
              value={platform}
              onChange={(event) => setPlatform(event.target.value)}
            >
              {SOCIAL_PLATFORMS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="input"
              value={revenuePlatform}
              maxLength={40}
              onChange={(event) => setRevenuePlatform(event.target.value.toUpperCase())}
            />
          )}
        </label>
        <label style={{ display: "grid", gap: 3, fontSize: 10.5 }}>
          Source
          <input
            className="input"
            value={source}
            maxLength={60}
            onChange={(event) => setSource(event.target.value)}
            placeholder="OPERATOR_ENTRY"
          />
        </label>
        <label style={{ display: "grid", gap: 3, fontSize: 10.5 }}>
          Confidence
          <select
            className="input"
            value={confidence}
            onChange={(event) => setConfidence(event.target.value)}
          >
            {DATA_CONFIDENCES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>

      {mode === "social" ? (
        <label style={{ display: "grid", gap: 3, fontSize: 10.5, maxWidth: 220 }}>
          Read from insights on
          <input
            className="input"
            type="date"
            value={measuredAt}
            onChange={(event) => setMeasuredAt(event.target.value)}
          />
        </label>
      ) : null}

      <div style={{ display: "grid", gap: 8 }}>
        {rows.map((row) => (
          <div
            key={row.key}
            className="card card-pad"
            style={{ display: "grid", gap: 6, background: "transparent" }}
          >
            <div style={{ display: "flex", gap: 8 }}>
              <label style={{ display: "grid", gap: 3, fontSize: 10.5, flex: 2 }}>
                {mode === "social" ? "Post id or permalink" : "Date"}
                <input
                  className="input"
                  type={mode === "social" ? "text" : "date"}
                  value={row.identity}
                  onChange={(event) => setIdentity(row.key, event.target.value)}
                  placeholder={mode === "social" ? "Platform post id, or the post URL" : ""}
                />
              </label>
              {mode === "social" ? (
                <label style={{ display: "grid", gap: 3, fontSize: 10.5, flex: 1 }}>
                  Published
                  <input
                    className="input"
                    type="date"
                    value={row.publishedAt}
                    onChange={(event) => setPublished(row.key, event.target.value)}
                  />
                </label>
              ) : null}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))",
                gap: 6,
              }}
            >
              {metrics.map(([field, label]) => (
                <label key={field} style={{ display: "grid", gap: 3, fontSize: 10 }}>
                  {label}
                  <input
                    className="input"
                    inputMode="numeric"
                    value={row.values[field] ?? ""}
                    placeholder="—"
                    onChange={(event) => setValue(row.key, field, event.target.value)}
                  />
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          className="button"
          onClick={() => setRows((current) => [...current, blankRow(current.length)])}
        >
          Add row
        </button>
        <button className="button primary" disabled={busy} onClick={() => void submit()}>
          {busy ? "Importing…" : "Import"}
        </button>
        <button className="button" disabled={busy} onClick={() => setOpen(false)}>
          Close
        </button>
      </div>

      {message ? (
        <span role="alert" style={{ fontSize: 10, color: "var(--red)" }}>
          {message}
        </span>
      ) : null}
      {ok ? (
        <span role="status" style={{ fontSize: 10, color: "var(--green)" }}>
          {ok}
        </span>
      ) : null}
    </section>
  );
}
