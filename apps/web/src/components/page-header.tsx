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
  // Only demo mode gets a banner. In live mode there is nothing to warn about,
  // and a permanent "LIVE ENVIRONMENT" bar is a line of chrome on every page
  // that tells an operator something they already know.
  //
  // The demo warning stays: it is the one case where the screen would
  // otherwise show fictional creators and invented revenue with nothing
  // saying so. Read from the server contract, never from a client env var --
  // reading it client-side once let a live deployment render the reassuring
  // banner over real Foundry data.
  const demo = useDemoMode();
  if (!demo) return null;
  return (
    <div className="demo-strip">
      <span>
        <strong>DEMO MODE</strong> · Fictional operating data · Mock integrations
      </span>
      <span>Safe to explore</span>
    </div>
  );
}
