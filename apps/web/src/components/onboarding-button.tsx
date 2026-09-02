"use client";

import { useState } from "react";
import { PlayCircle } from "lucide-react";

export function OnboardingButton({ creatorId = "madison" }: { creatorId?: string }) {
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
