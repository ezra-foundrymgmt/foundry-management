"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";

/**
 * Resumes an activation parked in WAITING_EXTERNAL or repaired after a failure.
 * The route proves ownership from the session, so the creator id here is a
 * convenience for the caller, not the authorization boundary.
 */
export function ResumeWorkflowButton({ creatorId }: { creatorId: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const router = useRouter();

  async function resume() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/workflows/resume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ creatorId }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        status?: string;
      };
      if (!response.ok) throw new Error(payload.error ?? `Failed (${response.status})`);
      setMessage("Queued. The run continues from the step it reached.");
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Resume failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" className="button" disabled={busy} onClick={() => void resume()}>
        <RotateCcw size={13} /> {busy ? "Resuming…" : "Resume run"}
      </button>
      {message ? (
        <p style={{ fontSize: 11, color: "var(--ink-soft)", marginTop: 6 }}>{message}</p>
      ) : null}
    </div>
  );
}
