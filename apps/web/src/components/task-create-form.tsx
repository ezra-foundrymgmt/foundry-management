"use client";

import { useState } from "react";
import { WORK_DEPARTMENTS, WORK_PRIORITIES } from "@creatoros/domain";

export interface TaskCreatorOption {
  id: string;
  name: string;
}

export interface CreatedTask {
  id: string;
  title: string;
  priority: string | null;
  status: string;
  department: string | null;
  creator_id: string | null;
  due_at: string | null;
  updated_at: string;
}

/** What each refusal means to the operator reading it. */
const MESSAGES: Record<string, string> = {
  INVALID_INPUT: "Check the title, department and priority before saving.",
  CREATOR_NOT_FOUND: "That creator is not in this organization.",
  PERMISSION_DENIED: "Creating tasks requires task permissions.",
  AUTHENTICATION_REQUIRED: "Your session expired. Sign in again.",
  DATABASE_NOT_CONFIGURED: "The live database is not configured in this environment.",
  TASK_DATABASE_FAILED: "The task could not be saved. Nothing changed.",
};

/**
 * Creates a task directly.
 *
 * Until this existed the only way a row reached `tasks` was as a by-product of a
 * generated report recommendation, so the Tasks page carried a permanently
 * disabled "Create task" button and any work that did not originate in a report
 * had nowhere to live.
 *
 * The creator link is optional on purpose — plenty of Foundry work is not
 * creator-scoped — and the server proves any creator id supplied belongs to the
 * caller's organization before attaching it.
 */
export function TaskCreateForm({
  creators,
  team,
  onCreated,
}: {
  creators: TaskCreatorOption[];
  team: Array<{ id: string; name: string }>;
  onCreated: (task: CreatedTask) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [department, setDepartment] = useState<string>("Operations");
  const [priority, setPriority] = useState<string>("MEDIUM");
  const [creatorId, setCreatorId] = useState("");
  // Unassigned is a legitimate choice, so this starts empty rather than
  // defaulting to whoever happens to be first in the roster.
  const [ownerUserId, setOwnerUserId] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function submit() {
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: title.trim(),
        department,
        priority,
        creatorId: creatorId === "" ? null : creatorId,
        ownerUserId: ownerUserId === "" ? null : ownerUserId,
        // A date input gives a calendar day with no timezone of its own; the API
        // wants an instant. Anchoring at noon UTC — rather than the browser's
        // local noon — keeps the stored date matching what was picked regardless
        // of the viewer's offset: a local anchor shifts the UTC calendar day for
        // any zone more than 12 hours from UTC (e.g. Pacific/Auckland during
        // daylight saving, UTC+13), and that shift then reads differently again
        // wherever the date is displayed, since the server renders it in its own
        // timezone rather than the viewer's.
        dueAt: dueAt === "" ? null : new Date(`${dueAt}T12:00:00Z`).toISOString(),
      }),
    });
    const data = (await response.json()) as { data?: CreatedTask; error?: string };
    setBusy(false);
    if (!response.ok || !data.data) {
      setMessage(
        (data.error && MESSAGES[data.error]) ?? "That task could not be saved. Nothing changed.",
      );
      return;
    }
    onCreated(data.data);
    setTitle("");
    setDueAt("");
    setCreatorId("");
    setOpen(false);
  }

  if (!open)
    return (
      <button className="button primary" onClick={() => setOpen(true)}>
        Create task
      </button>
    );

  return (
    <section className="card card-pad" style={{ display: "grid", gap: 8, minWidth: 320 }}>
      <label style={{ display: "grid", gap: 4, fontSize: 11 }}>
        Title
        <input
          className="input"
          value={title}
          maxLength={500}
          placeholder="What needs doing"
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label style={{ display: "grid", gap: 4, fontSize: 11 }}>
        Department
        <select
          className="input"
          value={department}
          onChange={(event) => setDepartment(event.target.value)}
        >
          {WORK_DEPARTMENTS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label style={{ display: "grid", gap: 4, fontSize: 11 }}>
        Priority
        <select
          className="input"
          value={priority}
          onChange={(event) => setPriority(event.target.value)}
        >
          {WORK_PRIORITIES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label style={{ display: "grid", gap: 4, fontSize: 11 }}>
        Creator (optional)
        <select
          className="input"
          value={creatorId}
          onChange={(event) => setCreatorId(event.target.value)}
        >
          <option value="">Foundry — not creator-scoped</option>
          {creators.map((creator) => (
            <option key={creator.id} value={creator.id}>
              {creator.name}
            </option>
          ))}
        </select>
      </label>
      <label style={{ display: "grid", gap: 4, fontSize: 11 }}>
        Owner (optional)
        <select
          className="input"
          value={ownerUserId}
          onChange={(event) => setOwnerUserId(event.target.value)}
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
        Due (optional)
        <input
          className="input"
          type="date"
          value={dueAt}
          onChange={(event) => setDueAt(event.target.value)}
        />
      </label>
      {message ? (
        <span role="status" style={{ fontSize: 10, color: "var(--red)" }}>
          {message}
        </span>
      ) : null}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          className="button primary"
          disabled={busy || title.trim().length === 0}
          onClick={() => void submit()}
        >
          {busy ? "Saving" : "Save task"}
        </button>
        <button className="button" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </section>
  );
}
