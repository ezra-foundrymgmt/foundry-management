"use client";

import { useDemoMode } from "./mode-provider";
export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow?: string;
  title: string;
  subtitle: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
        <h1>{title}</h1>
        <p className="subtitle">{subtitle}</p>
      </div>
      {actions ? <div className="actions">{actions}</div> : null}
    </header>
  );
}

export function DemoStrip() {
  // From the server contract. Reading a client env var here meant a live
  // deployment could render the reassuring "DEMO MODE · Safe to explore" banner
  // while showing real Foundry data, or the reverse.
  const demo = useDemoMode();
  return (
    <div className={`demo-strip ${demo ? "" : "live-strip"}`}>
      <span>
        <strong>{demo ? "DEMO MODE" : "LIVE ENVIRONMENT"}</strong> ·{" "}
        {demo
          ? "Fictional operating data · Mock integrations"
          : "Authenticated Foundry data · Audited integrations"}
      </span>
      <span>{demo ? "Safe to explore" : "CreatorOS is the source of truth"}</span>
    </div>
  );
}
