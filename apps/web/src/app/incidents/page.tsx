import { Plus, ShieldCheck } from "lucide-react";
import { DemoStrip, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
const incidents = [
  {
    id: "INC-0008",
    title: "Instagram data sync degraded",
    creator: "Sarah Vale",
    type: "INTEGRATION",
    severity: "MEDIUM",
    owner: "Owen Reed",
    detected: "Sep 2 · 6:04 AM",
    status: "OPEN",
  },
];
export default function IncidentsPage() {
  return (
    <main className="page">
      <DemoStrip />
      <PageHeader
        eyebrow="Risk & response"
        title="Incidents"
        subtitle="Operational, platform, data, relationship, security, and compliance issues with explicit ownership."
        actions={
          <button
            className="button primary"
            disabled
            title="Incident persistence requires the live database"
          >
            <Plus size={14} /> Log incident
          </button>
        }
      />
      <section className="card">
        {incidents.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Incident</th>
                  <th>Creator</th>
                  <th>Type</th>
                  <th>Severity</th>
                  <th>Owner</th>
                  <th>Detected</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {incidents.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.title}</strong>
                      <br />
                      <span style={{ fontSize: 10, color: "var(--ink-soft)" }}>{item.id}</span>
                    </td>
                    <td>{item.creator}</td>
                    <td>{item.type}</td>
                    <td>
                      <StatusBadge value={item.severity} />
                    </td>
                    <td>{item.owner}</td>
                    <td>{item.detected}</td>
                    <td>
                      <StatusBadge value={item.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <ShieldCheck size={28} />
            <strong>No open incidents</strong>Portfolio risk is clear.
          </div>
        )}
      </section>
    </main>
  );
}
