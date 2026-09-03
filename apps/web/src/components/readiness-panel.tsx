import { StatusBadge } from "@/components/status-badge";
import type { ActivationReadiness, ActivationReadinessStatus } from "@/lib/activation-readiness";

/**
 * Readiness is either evaluated against live records or it is not known. There
 * is no third state: a panel that quietly rendered "READY" because it could not
 * reach the database would be the most dangerous thing on this page.
 */
export type ReadinessState =
  { evaluated: true; readiness: ActivationReadiness } | { evaluated: false; reason: string };

const EXPLANATION: Record<ActivationReadinessStatus, string> = {
  READY: "Every record this creator's ACTIVE status depends on is present.",
  WAITING: "Provisioning is complete. CreatorOS is waiting on data it cannot produce itself.",
  BLOCKED: "A human decision is missing. CreatorOS cannot proceed until someone acts.",
  INCOMPLETE: "Provisioning did not leave behind a record CreatorOS owes this creator.",
};

export function ReadinessPanel({ state }: { state: ReadinessState }) {
  if (!state.evaluated)
    return (
      <section className="card card-pad">
        <h2>Activation readiness</h2>
        <p className="subtitle" style={{ marginTop: 8 }}>
          Not evaluated: {state.reason}
        </p>
      </section>
    );

  const { status, checks } = state.readiness;
  const unsatisfied = checks.filter((check) => !check.satisfied);

  return (
    <section className="card card-pad">
      <div className="section-head" style={{ padding: 0 }}>
        <h2>Activation readiness</h2>
        <StatusBadge value={status} />
      </div>
      <p className="subtitle" style={{ marginTop: 8, lineHeight: 1.6 }}>
        {EXPLANATION[status]}
      </p>

      {unsatisfied.length ? (
        <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0", display: "grid", gap: 8 }}>
          {unsatisfied.map((check) => (
            <li
              key={check.id}
              style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 11 }}
            >
              <StatusBadge value={check.severity} />
              <span>
                <strong>{check.label}</strong>
                <span style={{ color: "var(--ink-soft)" }}> — {check.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <p style={{ fontSize: 11, color: "var(--ink-soft)", marginTop: 12 }}>
        {checks.length - unsatisfied.length} of {checks.length} conditions satisfied. Checked
        against records, not workflow progress.
      </p>
    </section>
  );
}
