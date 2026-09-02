import { contentPerformance } from "@creatoros/domain";
import { Plus } from "lucide-react";
import { DemoStrip, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";

const requests = [
  {
    title: "Relationship POV variants",
    creator: "Madison Carter",
    platform: "Instagram",
    due: "Sep 5",
    status: "FILMING",
    priority: "HIGH",
  },
  {
    title: "Fall morning routine",
    creator: "Ava Monroe",
    platform: "TikTok",
    due: "Sep 6",
    status: "REVIEW",
    priority: "MEDIUM",
  },
  {
    title: "Reach recovery test",
    creator: "Sarah Vale",
    platform: "Instagram",
    due: "Sep 3",
    status: "ACKNOWLEDGED",
    priority: "CRITICAL",
  },
];
export default function ContentPage() {
  return (
    <main className="page">
      <DemoStrip />
      <PageHeader
        eyebrow="Creative operations"
        title="Content intelligence"
        subtitle="Turn research into hypotheses, requests, measured executions, repeatable franchises, and fatigue signals."
        actions={
          <button
            className="button primary"
            disabled
            title="Content request persistence requires the live database"
          >
            <Plus size={14} /> New content request
          </button>
        }
      />
      <div className="grid detail-grid" style={{ marginBottom: 14 }}>
        <section className="card card-pad">
          <div className="metric-label">OPEN REQUESTS</div>
          <div className="metric-value">12</div>
          <div className="metric-foot">3 due this week</div>
        </section>
        <section className="card card-pad">
          <div className="metric-label">WINNING FRANCHISES</div>
          <div className="metric-value">4</div>
          <div className="metric-foot trend-up">+1 this month</div>
        </section>
        <section className="card card-pad">
          <div className="metric-label">INVENTORY RISK</div>
          <div className="metric-value">1</div>
          <div className="metric-foot trend-down">Sarah · 5 days</div>
        </section>
      </div>
      <div className="grid dashboard-grid">
        <section className="card">
          <div className="section-head">
            <h2>Creator requests</h2>
            <span className="link">Workflow by status</span>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Creator</th>
                  <th>Platform</th>
                  <th>Due</th>
                  <th>Priority</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((item) => (
                  <tr key={item.title}>
                    <td>
                      <strong>{item.title}</strong>
                    </td>
                    <td>{item.creator}</td>
                    <td>{item.platform}</td>
                    <td>{item.due}</td>
                    <td>
                      <StatusBadge value={item.priority} />
                    </td>
                    <td>
                      <StatusBadge value={item.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <aside className="card">
          <div className="section-head">
            <h2>Format signals</h2>
          </div>
          {contentPerformance.map((item) => (
            <div className="report-item" key={item.id}>
              <div className="report-item-top">
                <strong>{item.title}</strong>
                <StatusBadge value={item.status} />
              </div>
              <p>
                {item.multiplier.toFixed(2)}× creator rolling 28-day median · {item.franchise}
              </p>
            </div>
          ))}
        </aside>
      </div>
    </main>
  );
}
