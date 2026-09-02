import { ACTIVATION_STEPS } from "@creatoros/workflows";
import { creators } from "@creatoros/domain";
import { Filter, RotateCcw } from "lucide-react";
import { DemoStrip, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { OnboardingButton } from "@/components/onboarding-button";

const completed = ACTIVATION_STEPS.slice(0, 24);
export default function WorkflowsPage() {
  const madison = creators[0];
  return (
    <main className="page">
      <DemoStrip />
      <PageHeader
        eyebrow="Deterministic operations"
        title="Workflow control"
        subtitle="Every durable run, step, retry, provider result, and blocker in one auditable view."
        actions={
          <>
            <button className="button" disabled title="Demo data contains no failed runs">
              <Filter size={13} /> Failed only
            </button>
            <OnboardingButton />
          </>
        }
      />
      <div className="grid dashboard-grid">
        <section className="card">
          <div className="section-head">
            <div>
              <h2 style={{ marginBottom: 3 }}>{madison?.stageName} — Creator Activation</h2>
              <span style={{ fontSize: 10, color: "var(--ink-soft)" }}>
                ONB-2026-000001 · CREATOR_ACTIVATION_V1
              </span>
            </div>
            <StatusBadge value="WAITING_EXTERNAL" />
          </div>
          <div className="card-pad">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 11,
                marginBottom: 7,
              }}
            >
              <strong>Operational provisioning</strong>
              <span>92%</span>
            </div>
            <div className="progress" style={{ height: 8 }}>
              <span style={{ width: "92%" }} />
            </div>
            <p className="subtitle" style={{ marginTop: 10 }}>
              Provisioning is complete. Activation is safely waiting for the baseline data
              requirement.
            </p>
          </div>
          <div className="workflow-steps card-pad" style={{ paddingTop: 0 }}>
            {ACTIVATION_STEPS.map((name, index) => {
              const waiting = index === 24;
              const pending = index === 25;
              const success = completed.includes(name);
              return (
                <div className="workflow-step" key={name}>
                  <span className="step-icon">{success ? "✓" : waiting ? "…" : index + 1}</span>
                  <span>{name.replaceAll("_", " ").toLowerCase()}</span>
                  <StatusBadge
                    value={
                      success
                        ? "SUCCEEDED"
                        : waiting
                          ? "WAITING_EXTERNAL"
                          : pending
                            ? "PENDING"
                            : "RUNNING"
                    }
                    label={success ? "DONE" : waiting ? "WAITING" : "PENDING"}
                  />
                </div>
              );
            })}
          </div>
        </section>
        <aside className="grid">
          <section className="card card-pad">
            <h2>Run details</h2>
            <div className="stat-list">
              <div className="stat-line">
                <span>Initiated by</span>
                <strong>Alex Morgan</strong>
              </div>
              <div className="stat-line">
                <span>Started</span>
                <strong>Sep 1 · 9:12 AM</strong>
              </div>
              <div className="stat-line">
                <span>Retries</span>
                <strong>1</strong>
              </div>
              <div className="stat-line">
                <span>Correlation ID</span>
                <strong>corr_81f2…</strong>
              </div>
              <div className="stat-line">
                <span>Provider mode</span>
                <StatusBadge value="MOCK" />
              </div>
            </div>
          </section>
          <section className="card card-pad">
            <h2>Current blocker</h2>
            <StatusBadge value="WAITING_EXTERNAL" label="BASELINE DATA" />
            <p className="subtitle" style={{ marginTop: 12, lineHeight: 1.6 }}>
              Social and creator-revenue connections are requested. The workflow will resume without
              repeating completed provisioning.
            </p>
            <button
              className="button"
              style={{ marginTop: 14 }}
              disabled
              title="Waiting for a live integration callback"
            >
              <RotateCcw size={13} /> Check readiness
            </button>
          </section>
          <section className="card card-pad">
            <h2>Idempotency</h2>
            <p className="subtitle" style={{ lineHeight: 1.6 }}>
              All five provisioned resources are protected by creator-scoped idempotency keys.
              Concurrent starts return this active run.
            </p>
          </section>
        </aside>
      </div>
    </main>
  );
}
