"use client";

import { UserRoundPlus } from "lucide-react";
import { useState } from "react";

export function ConvertProspectButton({ prospectId }: { prospectId: string }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  async function convert() {
    setState("loading");
    try {
      const response = await fetch("/api/prospects/convert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prospectId }),
      });
      if (!response.ok) throw new Error("Conversion failed");
      setState("done");
    } catch {
      setState("error");
    }
  }
  return (
    <button
      type="button"
      className="button bronze"
      onClick={() => void convert()}
      disabled={state === "loading" || state === "done"}
    >
      <UserRoundPlus size={13} />
      {state === "loading"
        ? "Converting…"
        : state === "done"
          ? "Creator created"
          : state === "error"
            ? "Retry conversion"
            : "Convert to creator"}
    </button>
  );
}
