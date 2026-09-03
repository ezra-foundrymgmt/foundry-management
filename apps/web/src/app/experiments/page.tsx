import { AccessDenied } from "@/components/access-denied";
import { DemoStrip, PageHeader } from "@/components/page-header";
import { LiveEmpty } from "@/components/live-empty";
import { StatusBadge } from "@/components/status-badge";
import { isMockMode } from "@/lib/environment";
import { getLiveExperiments, type LiveExperimentRow } from "@/lib/live-data";
import { authorizePage } from "@/lib/page-access";

/** Demo rows, shaped as live rows so there is one render path. */
const DEMO_EXPERIMENTS: LiveExperimentRow[] = [
  {
    id: "demo-exp-1",
    name: "Relationship POV hook order",
    creatorName: "Madison Carter",
    status: "ACTIVE",
    hypothesis: "Leading with the POV beat lifts profile visits against this creator's baseline.",
    primaryMetric: "Profile visits",
    result: null,
    confidence: "MEASURED",
    startedAt: "2026-08-20T00:00:00.000Z",
  },
  {
    id: "demo-exp-2",
    name: "Morning routine pacing",
    creatorName: "Ava Monroe",
    status: "COMPLETED",
    hypothesis: "A faster first five seconds increases shares per reach.",
    primaryMetric: "Shares / reach",
    result: "SCALE",
    confidence: "MEASURED",
    startedAt: "2026-08-05T00:00:00.000Z",
  },
];

export default async function ExperimentsPage() {
  const access = await authorizePage("analytics.read");
  if (!access.allowed)
    return <AccessDenied title="Experiments" permission="analytics.read" reason={access.reason} />;

  const mock = isMockMode();
  const experiments = mock ? DEMO_EXPERIMENTS : await getLiveExperiments();
  const active = experiments.filter((experiment) => experiment.status === "ACTIVE");

  return (
    <main className="page">
      <DemoStrip />
      <PageHeader
        eyebrow="Creative intelligence"
        title="Experiments"
        subtitle="One hypothesis at a time, measured against the creator's own baseline rather than the roster."
        actions={
          <span style={{ fontSize: 11, color: "var(--ink-soft)" }}>
            {active.length} active of {experiments.length}
          </span>
        }
      />

      {experiments.length === 0 ? (
        <LiveEmpty
          title="No experiments recorded"
          hint="Experiments appear here once a hypothesis is registered against a creator."
        />
      ) : (
        <section className="card">
          <div className="section-head">
            <h2>Experiment register</h2>
            <span className="subtitle">{active.length} running</span>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Experiment</th>
                  <th>Creator</th>
                  <th>Primary metric</th>
                  <th>Status</th>
                  <th>Result</th>
                  <th>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {experiments.map((experiment) => (
                  <tr key={experiment.id}>
                    <td>
                      <strong>{experiment.name}</strong>
                      <br />
                      <span style={{ fontSize: 10, color: "var(--ink-soft)" }}>
                        {experiment.hypothesis}
                      </span>
                    </td>
                    <td>{experiment.creatorName}</td>
                    <td>{experiment.primaryMetric}</td>
                    <td>
                      <StatusBadge value={experiment.status} />
                    </td>
                    {/* An experiment with no recorded decision is undecided, not a
                        negative result. */}
                    <td>{experiment.result ?? "Undecided"}</td>
                    <td>
                      <StatusBadge value={experiment.confidence} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
