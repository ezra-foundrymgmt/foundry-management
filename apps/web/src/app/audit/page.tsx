import { Download, Filter } from "lucide-react";
import { DemoStrip, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { isMockMode } from "@/lib/environment";
import { getLiveAuditEvents } from "@/lib/live-data";
const demoEvents = [
  {
    action: "creator.onboarding.started",
    resource: "Madison Carter",
    actor: "Alex Morgan",
    type: "USER",
    time: "Sep 2 · 8:28:14",
    correlation: "corr_81f2",
  },
  {
    action: "report.generated",
    resource: "Sarah Vale",
    actor: "daily-report.workflow",
    type: "WORKFLOW",
    time: "Sep 2 · 8:26:08",
    correlation: "corr_77aa",
  },
  {
    action: "creator.health.changed",
    resource: "Sarah Vale",
    actor: "health-score.service",
    type: "SYSTEM",
    time: "Sep 2 · 8:18:42",
    correlation: "corr_77aa",
  },
  {
    action: "integration.sync.completed",
    resource: "Mock Revenue",
    actor: "mock-revenue.provider",
    type: "INTEGRATION",
    time: "Sep 2 · 8:16:03",
    correlation: "corr_144c",
  },
];
export default async function AuditPage() {
  const events = isMockMode() ? demoEvents : await getLiveAuditEvents();
  return (
    <main className="page">
      <DemoStrip />
      <PageHeader
        eyebrow="Immutable-ish history"
        title="Audit trail"
        subtitle="Important changes are attributed to users, systems, workflows, integrations, or approved AI tools."
        actions={
          <button
            className="button"
            disabled
            title="Export is available after the live audit store is connected"
          >
            <Download size={13} /> Export
          </button>
        }
      />
      <section className="card">
        <div className="table-toolbar">
          <button className="button" disabled title="Saved filters require the live audit store">
            <Filter size={13} /> All actors
          </button>
          <button className="button" disabled title="Saved filters require the live audit store">
            All resources
          </button>
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-soft)" }}>
            No sensitive payloads logged
          </span>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Resource</th>
                <th>Actor</th>
                <th>Actor type</th>
                <th>Occurred</th>
                <th>Correlation</th>
              </tr>
            </thead>
            <tbody>
              {events.map((item) => (
                <tr key={`${item.action}-${item.time}`}>
                  <td>
                    <code>{item.action}</code>
                  </td>
                  <td>
                    <strong>{item.resource}</strong>
                  </td>
                  <td>{item.actor}</td>
                  <td>
                    <StatusBadge value={item.type} />
                  </td>
                  <td>{item.time}</td>
                  <td>
                    <code>{item.correlation}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
