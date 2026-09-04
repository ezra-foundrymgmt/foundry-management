"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { clampFollowerEstimate } from "@creatoros/domain";

/**
 * What each server refusal means to the operator reading it.
 *
 * Every code POST /api/prospects can return has an entry. A missing one falls
 * through to the generic message below, which is worse than it looks: it is
 * the difference between "wait a moment and try again" and "this will never
 * work", and the operator cannot tell which they are looking at.
 */
const MESSAGES: Record<string, string> = {
  INVALID_INPUT: "Check the stage name, preferred name and email before saving.",
  PERMISSION_DENIED: "Adding prospects requires prospect permissions.",
  AUTHENTICATION_REQUIRED: "Your session expired. Sign in again.",
  // Retryable, and the one most likely to be hit during a prospecting session.
  RATE_LIMITED: "Too many requests just now. Wait a moment and try again.",
  WRITES_REQUIRE_LIVE_MODE: "This environment is read-only. Prospects cannot be added here.",
  PROSPECT_DATABASE_FAILED: "The prospect could not be saved. Nothing changed.",
  // Deliberately does not promise "nothing changed": this is the route's
  // catch-all, and it can fire after the row has already committed.
  PROSPECT_CREATE_FAILED: "Something went wrong saving the prospect. Reload before retrying.",
};

/**
 * Adds a prospect to the pipeline.
 *
 * `POST /api/prospects` has existed since the CRM was built, with duplicate
 * detection and an audit entry, and nothing in the product ever called it --
 * a prospect could only be created by an API client or direct SQL. Prospecting
 * is the daily job, so the absence of this form meant the pipeline could not
 * be fed at all through CreatorOS.
 */
export function ProspectCreateForm() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    preferredName: "",
    stageName: "",
    email: "",
    niche: "",
    primarySocialPlatform: "",
    followerCountEstimate: "",
    source: "",
  });
  const [, startTransition] = useTransition();
  const router = useRouter();

  function set(field: keyof typeof form, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Optional fields are omitted rather than sent empty: the schema
      // validates an email if one is present, so "" would be rejected.
      const followers = Number.parseInt(form.followerCountEstimate, 10);
      const body: Record<string, unknown> = {
        preferredName: form.preferredName.trim(),
        stageName: form.stageName.trim(),
      };
      if (form.email.trim()) body["email"] = form.email.trim();
      if (form.niche.trim()) body["niche"] = form.niche.trim();
      if (form.primarySocialPlatform.trim())
        body["primarySocialPlatform"] = form.primarySocialPlatform.trim();
      if (Number.isFinite(followers) && followers >= 0) body["followerCountEstimate"] = followers;
      if (form.source.trim()) body["source"] = form.source.trim();

      const response = await fetch("/api/prospects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        const reason = payload.error ?? `Request failed (${response.status})`;
        // The duplicate guard returns the existing prospect's number so the
        // operator can go find it instead of creating a second record.
        if (reason.startsWith("DUPLICATE_PROSPECT"))
          throw new Error(
            `Already in the pipeline as ${reason.split(":")[1] ?? "an existing prospect"}.`,
          );
        // Anything else is a machine code. Rendering it raw put the literal
        // string "INVALID_INPUT" in front of the operator, which names no
        // field and suggests no fix.
        throw new Error(MESSAGES[reason] ?? "The prospect could not be saved. Nothing changed.");
      }
      setForm({
        preferredName: "",
        stageName: "",
        email: "",
        niche: "",
        primarySocialPlatform: "",
        followerCountEstimate: "",
        source: "",
      });
      setOpen(false);
      startTransition(() => router.refresh());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add prospect");
    } finally {
      setBusy(false);
    }
  }

  if (!open)
    return (
      <button type="button" className="button primary" onClick={() => setOpen(true)}>
        <Plus size={14} /> Add prospect
      </button>
    );

  return (
    <form className="card card-pad" style={{ display: "grid", gap: 10, minWidth: 320 }} onSubmit={(event) => void submit(event)}>
      <strong style={{ fontSize: 12 }}>New prospect</strong>
      {error ? (
        <p role="alert" style={{ color: "var(--red)", fontSize: 11, margin: 0 }}>
          {error}
        </p>
      ) : null}

      <label style={{ display: "grid", gap: 3, fontSize: 10.5 }}>
        Stage name *
        <input
          className="input"
          required
          maxLength={120}
          value={form.stageName}
          onChange={(event) => set("stageName", event.target.value)}
          placeholder="How they are known publicly"
        />
      </label>
      <label style={{ display: "grid", gap: 3, fontSize: 10.5 }}>
        Preferred name *
        <input
          className="input"
          required
          maxLength={120}
          value={form.preferredName}
          onChange={(event) => set("preferredName", event.target.value)}
          placeholder="What you call them"
        />
      </label>
      <label style={{ display: "grid", gap: 3, fontSize: 10.5 }}>
        Email
        <input
          className="input"
          type="email"
          maxLength={200}
          value={form.email}
          onChange={(event) => set("email", event.target.value)}
          placeholder="Used to detect duplicates"
        />
      </label>
      <label style={{ display: "grid", gap: 3, fontSize: 10.5 }}>
        Niche
        <input
          className="input"
          maxLength={120}
          value={form.niche}
          onChange={(event) => set("niche", event.target.value)}
        />
      </label>
      <label style={{ display: "grid", gap: 3, fontSize: 10.5 }}>
        Primary platform
        <input
          className="input"
          maxLength={60}
          value={form.primarySocialPlatform}
          onChange={(event) => set("primarySocialPlatform", event.target.value)}
          placeholder="Instagram, TikTok, X…"
        />
      </label>
      <label style={{ display: "grid", gap: 3, fontSize: 10.5 }}>
        Follower estimate
        <input
          className="input"
          inputMode="numeric"
          // The server caps this at MAX_FOLLOWER_ESTIMATE. Clamping while the
          // operator types keeps the field inside the bound, rather than
          // accepting a larger number and answering INVALID_INPUT — a code
          // that names no field — after a round trip.
          value={form.followerCountEstimate}
          onChange={(event) => set("followerCountEstimate", clampFollowerEstimate(event.target.value))}
        />
      </label>
      <label style={{ display: "grid", gap: 3, fontSize: 10.5 }}>
        Source
        <input
          className="input"
          maxLength={80}
          value={form.source}
          onChange={(event) => set("source", event.target.value)}
          placeholder="Referral, outbound, inbound…"
        />
      </label>

      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" className="button primary" disabled={busy}>
          {busy ? "Adding…" : "Add to pipeline"}
        </button>
        <button type="button" className="button" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
      <p className="subtitle" style={{ fontSize: 10, margin: 0 }}>
        Enters the pipeline at SOURCED. Move it through the stages on the board.
      </p>
    </form>
  );
}
