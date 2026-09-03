"use client";

import { useState } from "react";
import { WORK_PRIORITIES } from "@creatoros/domain";
import { StatusBadge } from "@/components/status-badge";
import { UNKNOWN_DISPLAY } from "@/lib/format";

/** What each refusal means to the operator reading it. */
const MESSAGES: Record<string, string> = {
  CREATOR_CHANGED_REFRESH_REQUIRED:
    "Someone else changed this creator first. Reload before re-triaging.",
  CREATOR_NOT_FOUND: "That creator is no longer available.",
  PERMISSION_DENIED: "Changing a creator's priority requires creator administration.",
  AUTHENTICATION_REQUIRED: "Your session expired. Sign in again.",
  DATABASE_NOT_CONFIGURED: "The live database is not configured in this environment.",
};

/**
 * Sets a creator's operational priority.
 *
 * `updatedAt` is the row's own timestamp, sent back with the write so two people
 * re-triaging the same creator from stale views get a refresh prompt rather than
 * one silently overwriting the other. The new token is read back from the
 * response, so a second change in the same session does not need a reload.
 *
 * Read-only covers demo mode, where there is no row to write to.
 */
export function CreatorPriorityControl({
  creatorId,
  priority,
  updatedAt,
  readOnly = false,
}: {
  creatorId: string;
  priority: string | null;
  updatedAt: string;
  readOnly?: boolean;
}) {
  const [current, setCurrent] = useState(priority);
  const [token, setToken] = useState(updatedAt);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function change(next: string) {
    setBusy(true);
    setMessage("");
    const response = await fetch(`/api/creators/${creatorId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      // An empty selection clears the priority back to untriaged rather than
      // forcing a level nobody chose.
      body: JSON.stringify({ priority: next === "" ? null : next, updatedAt: token }),
    });
    const data = (await response.json()) as {
      priority?: string | null;
      updatedAt?: string;
      error?: string;
    };
    setBusy(false);
    if (!response.ok || !data.updatedAt) {
      setMessage(
        (data.error && MESSAGES[data.error]) ?? "That priority could not be saved. Nothing changed.",
      );
      return;
    }
    setCurrent(data.priority ?? null);
    setToken(data.updatedAt);
  }

  return (
    <article className="card metric-card">
      <div className="metric-label">
        <span>Priority</span>
      </div>
      <div className="metric-value" style={{ fontSize: 18 }}>
        {current ? <StatusBadge value={current} /> : UNKNOWN_DISPLAY}
      </div>
      {readOnly ? (
        <span style={{ fontSize: 10, color: "var(--ink-soft)" }}>
          Triage requires the live database
        </span>
      ) : (
        <select
          className="input"
          aria-label="Creator priority"
          value={current ?? ""}
          disabled={busy}
          onChange={(event) => void change(event.target.value)}
        >
          <option value="">Not triaged</option>
          {WORK_PRIORITIES.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      )}
      {message ? (
        <span role="status" style={{ fontSize: 10, color: "var(--red)" }}>
          {message}
        </span>
      ) : null}
    </article>
  );
}
