import { DemoStrip, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { ClipboardCheck, Plus } from "lucide-react";

const applications = [
  {
    id: "APP-000021",
    name: "Nora Quinn",
    source: "Website",
    received: "Sep 1, 2026",
    revenue: "$10K–$25K",
    status: "NEW",
  },
  {
    id: "APP-000020",
    name: "Emery Lane",
    source: "Referral",
    received: "Aug 30, 2026",
    revenue: "$5K–$10K",
    status: "REVIEWING",
  },
  {
    id: "APP-000019",
    name: "Sloane Avery",
    source: "Website",
    received: "Aug 27, 2026",
    revenue: "$25K–$50K",
    status: "QUALIFIED",
  },
];

export default function ApplicationsPage() {
  return (
    <main className="page">
      <DemoStrip />
      <PageHeader
        eyebrow="Inbound"
        title="Creator applications"
        subtitle="Review applicants, link them to prospects, and convert signed candidates without losing source history."
        actions={
          <button
            className="button primary"
            disabled
            title="Demo mode is read-only for applications"
          >
            <Plus size={14} /> New application
          </button>
        }
      />
      <section className="card">
        <div className="section-head">
          <h2>Review queue</h2>
          <StatusBadge value="READY" label="3 TO REVIEW" />
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Applicant</th>
                <th>Application</th>
                <th>Source</th>
                <th>Revenue range</th>
                <th>Received</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {applications.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.name}</strong>
                  </td>
                  <td>{item.id}</td>
                  <td>{item.source}</td>
                  <td>{item.revenue}</td>
                  <td>{item.received}</td>
                  <td>
                    <StatusBadge value={item.status} />
                  </td>
                  <td>
                    <button
                      className="button"
                      disabled
                      title="Application editing requires the live database"
                    >
                      <ClipboardCheck size={13} /> Review
                    </button>
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
