"use client";

import { useState } from "react";
import { PlayCircle } from "lucide-react";

/**
 * Deliberately no default creatorId. It had one — "madison" — which is a valid
 * key in the mock-mode fixture set (packages/domain/src/seed.ts), so every
 * "Start activation" button silently worked in mock mode no matter which page
 * rendered it. In live mode "madison" is not a UUID: the request failed with
 * CREATOR_LOOKUP_FAILED for every real creator, on every page, and mock mode
 * never had a chance to catch it because the fixture happened to match the
 * fallback.
 */
export function OnboardingButton({ creatorId }: { creatorId: string }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  async function start() {
    setState("loading");
    try {
      const response = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ creatorId }),
      });
      if (!response.ok) throw new Error("Request failed");
      setState("done");
    } catch {
      setState("error");
    }
  }
  return (
    <button
      className="button bronze"
      type="button"
      onClick={() => void start()}
      disabled={state === "loading" || state === "done"}
    >
      <PlayCircle size={14} />
      {state === "loading"
        ? "Starting…"
        : state === "done"
          ? "Activation ready"
          : state === "error"
            ? "Retry activation"
            : "Start activation"}
    </button>
  );
}
