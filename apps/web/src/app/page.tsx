import Link from "next/link";
import { ArrowRight, CircleAlert, Clock3 } from "lucide-react";
import { creators, reports, tasks } from "@creatoros/domain";
import { DemoStrip, PageHeader } from "@/components/page-header";
import { MetricCard } from "@/components/metric-card";
import { StatusBadge } from "@/components/status-badge";

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export default function CommandCenterPage() {
  const totalRevenue = creators.reduce((sum, creator) => sum + creator.monthlyRevenue, 0);
  const needAttention = creators.filter((creator) => creator.healthBand !== "GREEN");
  return (
    <main className="page">
      <DemoStrip />
      <PageHeader
        eyebrow="Wednesday · September 2"
        title="Foundry Command Center"
        subtitle="What is happening, why it matters, and what needs to happen next."
        actions={
          <>
            <button
              className="button"
              disabled
              title="Available after a live report store is connected"
            >
              Export not configured
            </button>
            <Link className="button primary" href="/reports">
              Review daily reports <ArrowRight size={14} />
            </Link>
          </>
        }
      />
      <section className="grid metrics-grid" aria-label="Portfolio summary">
        <MetricCard
          label="Creator receipts"
          value={money.format(totalRevenue)}
          change={9.4}
          context="vs prior 30 days"
        />
        <MetricCard
          label="Contribution profit"
          value="$42,680"
          change={6.8}
          context="41.7% margin"
        />
        <MetricCard
          label="Portfolio health"
          value="73 / 100"
          change={-2.1}
          context="2 need attention"
        />
        <MetricCard label="Scale readiness" value="78 / 100" context="Gate is 85" />
      </section>
      <div className="grid dashboard-grid">
        <div className="grid">
          <section className="card">
            <div className="section-head">
              <h2>Requires attention</h2>
              <span className="badge red">
                <CircleAlert size={11} /> {needAttention.length} CREATORS
              </span>
            </div>
            <div className="attention-list">
              {needAttention.map((creator) => (
                <Link href={`/creators/${creator.id}`} className="attention-row" key={creator.id}>
                  <div className="creator-cell">
                    <strong>{creator.stageName}</strong>
                    <span>
                      {creator.creatorNumber} · {creator.owner}
                    </span>
                  </div>
                  <div className="signal">
                    <strong>{creator.primaryBottleneck}</strong>
                    <small>
                      {creator.id === "madison"
                        ? "Acquisition +9%, first purchase −17%"
                        : "Reach −31%, buffer critical"}
                    </small>
                  </div>
                  <div className="mini-stat">
                    <span>Health</span>
                    <strong>{creator.healthScore}</strong>
                  </div>
                  <StatusBadge value={creator.healthBand} />
                  <ArrowRight size={15} />
                </Link>
              ))}
            </div>
          </section>
          <section className="card">
            <div className="section-head">
              <h2>Creator portfolio</h2>
              <Link className="link" href="/creators">
                View portfolio
              </Link>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Creator</th>
                    <th>Receipts</th>
                    <th>30d trend</th>
                    <th>Health</th>
                    <th>Buffer</th>
                    <th>Integration</th>
                  </tr>
                </thead>
                <tbody>
                  {creators.map((creator) => (
                    <tr key={creator.id}>
                      <td>
                        <Link href={`/creators/${creator.id}`}>
                          <strong>{creator.stageName}</strong>
                          <br />
                          <span style={{ color: "var(--ink-soft)", fontSize: 10 }}>
                            {creator.creatorNumber}
                          </span>
                        </Link>
                      </td>
                      <td>{money.format(creator.monthlyRevenue)}</td>
                      <td className={creator.revenueTrendPercent >= 0 ? "trend-up" : "trend-down"}>
                        {creator.revenueTrendPercent > 0 ? "+" : ""}
                        {creator.revenueTrendPercent}%
                      </td>
                      <td>
                        <StatusBadge value={creator.healthBand} />
                      </td>
                      <td>{creator.contentBufferDays} days</td>
                      <td>
                        <StatusBadge value={creator.integrationHealth} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
        <aside className="grid">
          <section className="card">
            <div className="section-head">
              <h2>Report inbox</h2>
              <Link className="link" href="/reports">
                All reports
              </Link>
            </div>
            <div className="report-list">
              {reports.map((report) => {
                const creator = creators.find((item) => item.id === report.creatorId);
                return (
                  <Link
                    href={`/creators/${report.creatorId}`}
                    className="report-item"
                    key={report.id}
                  >
                    <div className="report-item-top">
                      <strong>{creator?.stageName}</strong>
                      <StatusBadge value={report.priority} />
                    </div>
                    <p>{report.summary}</p>
                  </Link>
                );
              })}
            </div>
          </section>
          <section className="card card-pad">
            <h2>Operating pulse</h2>
            <div className="stat-list">
              <div className="stat-line">
                <span>Overdue tasks</span>
                <strong>{tasks.filter((task) => task.status !== "DONE").length}</strong>
              </div>
              <div className="stat-line">
                <span>Failed workflows</span>
                <strong className="trend-down">0</strong>
              </div>
              <div className="stat-line">
                <span>Low content buffers</span>
                <strong>1</strong>
              </div>
              <div className="stat-line">
                <span>Open incidents</span>
                <strong>1</strong>
              </div>
            </div>
          </section>
          <section className="card card-pad">
            <h2>Recent activity</h2>
            <div className="activity">
              <span className="activity-dot" />
              <div>
                <strong>Daily reports generated</strong>
                <br />
                <span>Rules engine · 3 creators</span>
              </div>
              <time>8:26</time>
            </div>
            <div className="activity">
              <span className="activity-dot" />
              <div>
                <strong>Revenue import completed</strong>
                <br />
                <span>Mock provider · 84 rows</span>
              </div>
              <time>8:20</time>
            </div>
            <div className="activity">
              <span className="activity-dot" />
              <div>
                <strong>Sarah moved to At Risk</strong>
                <br />
                <span>Health rule HLT-04</span>
              </div>
              <time>8:18</time>
            </div>
            <div className="activity">
              <span className="activity-dot" />
              <div>
                <strong>Madison activation waiting</strong>
                <br />
                <span>Baseline connection required</span>
              </div>
              <time>
                <Clock3 size={12} />
              </time>
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
