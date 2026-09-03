import { ClipboardCheck } from "lucide-react";
import { AccessDenied } from "@/components/access-denied";
import { DemoStrip, PageHeader } from "@/components/page-header";
import { LiveEmpty } from "@/components/live-empty";
import { StatusBadge } from "@/components/status-badge";
import { isMockMode } from "@/lib/environment";
import { getLiveApplications, type LiveApplicationRow } from "@/lib/live-data";
import { authorizePage } from "@/lib/page-access";

/** Demo rows, shaped as live rows so there is one render path. */
const DEMO_APPLICATIONS: LiveApplicationRow[] = [
  {
    id: "demo-app-21",
    stageName: "Nora Quinn",
    preferredName: "Nora",
    email: "nora@fictional.demo",
    status: "NEW",
    submittedAt: "2026-09-01T12:00:00.000Z",
  },
  {
    id: "demo-app-20",
    stageName: "Emery Lane",
    preferredName: "Emery",
    email: "emery@fictional.demo",
    status: "REVIEWING",
    submittedAt: "2026-08-30T12:00:00.000Z",
  },
];

export default async function ApplicationsPage() {
  const access = await authorizePage("application.read");
  if (!access.allowed)
    return (
      <AccessDenied title="Applications" permission="application.read" reason={access.reason} />
    );

  const mock = isMockMode();
  const applications = mock ? DEMO_APPLICATIONS : await getLiveApplications();
  const awaiting = applications.filter((application) => application.status !== "DECLINED");

  return (
    <main className="page">
      <DemoStrip />
      <PageHeader
        eyebrow="Inbound"
        title="Applications"
        subtitle="Creator-initiated interest, reviewed against the same fit model as sourced prospects."
        actions={
          <span style={{ fontSize: 11, color: "var(--ink-soft)" }}>
            {awaiting.length} awaiting review
          </span>
        }
      />

      {applications.length === 0 ? (
        <LiveEmpty
          title="No applications received"
          hint="Inbound creator applications appear here for review and conversion to a prospect."
        />
      ) : (
        <section className="card">
          <div className="section-head">
            <h2>
              <ClipboardCheck size={16} /> Application queue
            </h2>
            <span className="subtitle">{applications.length} total</span>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Applicant</th>
                  <th>Email</th>
                  <th>Received</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {applications.map((application) => (
                  <tr key={application.id}>
                    <td>
                      <strong>{application.stageName}</strong>
                      <br />
                      <span style={{ fontSize: 10, color: "var(--ink-soft)" }}>
                        {application.preferredName}
                      </span>
                    </td>
                    <td>{application.email}</td>
                    <td>
                      {application.submittedAt
                        ? new Date(application.submittedAt).toLocaleDateString()
                        : "Not recorded"}
                    </td>
                    <td>
                      <StatusBadge value={application.status ?? "NEW"} />
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
