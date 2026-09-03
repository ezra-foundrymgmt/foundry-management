import { ShieldCheck } from "lucide-react";
import { AccessDenied } from "@/components/access-denied";
import { DemoStrip, PageHeader } from "@/components/page-header";
import { LiveEmpty } from "@/components/live-empty";
import { StatusBadge } from "@/components/status-badge";
import { isMockMode } from "@/lib/environment";
import { getLiveIncidents, type LiveIncidentRow } from "@/lib/live-data";
import { authorizePage } from "@/lib/page-access";

/** Demo rows, shaped as live rows so there is one render path. */
const DEMO_INCIDENTS: LiveIncidentRow[] = [
  {
    id: "demo-inc-0008",
    incidentNumber: "INC-0008",
    title: "Instagram data sync degraded",
    type: "INTEGRATION",
    severity: "MEDIUM",
    status: "OPEN",
    creatorName: "Sarah Vale",
    detectedAt: "2026-09-02T06:04:00.000Z",
    resolvedAt: null,
  },
];

export default async function IncidentsPage() {
  const access = await authorizePage("creator.read");
  if (!access.allowed)
    return <AccessDenied title="Incidents" permission="creator.read" reason={access.reason} />;

  const mock = isMockMode();
  const incidents = mock ? DEMO_INCIDENTS : await getLiveIncidents();
  const open = incidents.filter((incident) => incident.status !== "RESOLVED");

  return (
    <main className="page">
      <DemoStrip />
      <PageHeader
        eyebrow="Risk & response"
        title="Incidents"
        subtitle="Security, compliance, and integration failures that need a human owner and a resolution."
        actions={
          <span style={{ fontSize: 11, color: "var(--ink-soft)" }}>
            {open.length} open of {incidents.length}
          </span>
        }
      />

      {incidents.length === 0 ? (
        <LiveEmpty
          title="No incidents recorded"
          hint="Integration failures and compliance flags appear here as they are raised."
        />
      ) : (
        <section className="card">
          <div className="section-head">
            <h2>
              <ShieldCheck size={16} /> Incident register
            </h2>
            <span className="subtitle">{open.length} awaiting resolution</span>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Incident</th>
                  <th>Creator</th>
                  <th>Type</th>
                  <th>Severity</th>
                  <th>Detected</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {incidents.map((incident) => (
                  <tr key={incident.id}>
                    <td>
                      <strong>{incident.title}</strong>
                      <br />
                      <span style={{ fontSize: 10, color: "var(--ink-soft)" }}>
                        {incident.incidentNumber ?? incident.id.slice(0, 8)}
                      </span>
                    </td>
                    <td>{incident.creatorName ?? "Portfolio-wide"}</td>
                    <td>{incident.type}</td>
                    <td>
                      <StatusBadge value={incident.severity} />
                    </td>
                    <td>{new Date(incident.detectedAt).toLocaleString()}</td>
                    <td>
                      <StatusBadge value={incident.status} />
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
