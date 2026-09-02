import { Plus } from "lucide-react";
import { DemoStrip, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
const experiments = [
  {
    name: "Relationship POV hook order",
    creator: "Madison Carter",
    metric: "Profile visits",
    status: "ACTIVE",
    decision: "—",
    confidence: "MEASURED",
  },
  {
    name: "Morning routine pacing",
    creator: "Ava Monroe",
    metric: "Shares / reach",
    status: "COMPLETED",
    decision: "SCALE",
    confidence: "MEASURED",
  },
  {
    name: "Gym mirror refresh",
    creator: "Madison Carter",
    metric: "Reach",
    status: "COMPLETED",
    decision: "RETIRE",
    confidence: "PARTIALLY_MEASURED",
  },
];
export default function ExperimentsPage() {
  return (
    <main className="page">
      <DemoStrip />
      <PageHeader
        eyebrow="Research → measure → scale"
        title="Experiment registry"
        subtitle="Every creative or funnel test has a hypothesis, metric, result, confidence level, and decision."
        actions={
          <button
            className="button primary"
            disabled
            title="Experiment persistence requires the live database"
          >
            <Plus size={14} /> Create experiment
          </button>
        }
      />
      <section className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Experiment</th>
                <th>Creator</th>
                <th>Primary metric</th>
                <th>Status</th>
                <th>Decision</th>
                <th>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {experiments.map((item) => (
                <tr key={item.name}>
                  <td>
                    <strong>{item.name}</strong>
                  </td>
                  <td>{item.creator}</td>
                  <td>{item.metric}</td>
                  <td>
                    <StatusBadge value={item.status} />
                  </td>
                  <td>
                    <StatusBadge value={item.decision} />
                  </td>
                  <td>{item.confidence.replaceAll("_", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
