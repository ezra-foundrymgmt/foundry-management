import { notFound } from "next/navigation";
import { contentPerformance, creators, reports, tasks } from "@creatoros/domain";
import { ArrowLeft, CalendarClock, CheckCircle2, ChevronRight } from "lucide-react";
import { OnboardingButton } from "@/components/onboarding-button";
import { StatusBadge } from "@/components/status-badge";

const tabs = [
  "Overview",
  "Growth",
  "Revenue",
  "Content",
  "Experiments",
  "Competitors",
  "Operations",
  "Tasks",
  "Reports",
  "Economics",
  "Integrations",
  "Compliance",
  "Activity",
];
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
export default async function CreatorPage({ params }: { params: Promise<{ creatorId: string }> }) {
  const { creatorId } = await params;
  const creator = creators.find((item) => item.id === creatorId);
  if (!creator) notFound();
  const report = reports.find((item) => item.creatorId === creator.id);
  const creatorTasks = tasks.filter((item) => item.creatorId === creator.id);
  return (
    <main className="page">
      <a
        className="link"
        href="/creators"
        style={{ display: "inline-flex", alignItems: "center", gap: 5, marginBottom: 15 }}
      >
        <ArrowLeft size={13} /> Creator portfolio
      </a>
      <header className="page-header">
        <div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 5 }}>
            <span className="eyebrow">{creator.creatorNumber}</span>
            <StatusBadge value={creator.status} />
            <StatusBadge value={creator.integrationHealth} />
          </div>
          <h1>{creator.stageName}</h1>
          <p className="subtitle">{creator.owner} · Creator Success · America/Los_Angeles</p>
        </div>
        <div className="actions">
          <button className="button" disabled title="Calendar integration is not configured">
            <CalendarClock size={14} /> Schedule review
          </button>
          {creator.status === "ONBOARDING" ? (
            <OnboardingButton creatorId={creator.id} />
          ) : (
            <a className="button primary" href="/tasks">
              Open tasks
            </a>
          )}
        </div>
      </header>
      <div className="grid metrics-grid">
        <article className="card metric-card">
          <div className="metric-label">HEALTH</div>
          <div className="metric-value">{creator.healthScore}</div>
          <StatusBadge value={creator.healthBand} />
        </article>
        <article className="card metric-card">
          <div className="metric-label">MONTHLY RECEIPTS</div>
          <div className="metric-value">{money.format(creator.monthlyRevenue)}</div>
          <div className="metric-foot">
            <strong className={creator.revenueTrendPercent >= 0 ? "trend-up" : "trend-down"}>
              {creator.revenueTrendPercent > 0 ? "+" : ""}
              {creator.revenueTrendPercent}%
            </strong>
            <span>vs prior period</span>
          </div>
        </article>
        <article className="card metric-card">
          <div className="metric-label">CONTENT BUFFER</div>
          <div className="metric-value">{creator.contentBufferDays}d</div>
          <div className="progress">
            <span style={{ width: `${Math.min(100, (creator.contentBufferDays / 14) * 100)}%` }} />
          </div>
        </article>
        <article className="card metric-card">
          <div className="metric-label">NEXT REVIEW</div>
          <div className="metric-value" style={{ fontSize: 22 }}>
            Sep 4
          </div>
          <div className="metric-foot">Recommended by CreatorOS</div>
        </article>
      </div>
      <nav className="tabs" aria-label="Creator sections">
        {tabs.map((tab, index) => (
          <span className={`tab ${index === 0 ? "active" : ""}`} key={tab}>
            {tab}
          </span>
        ))}
      </nav>
      <div className="grid dashboard-grid">
        <div className="grid">
          <section className="card card-pad">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h2>Today’s operating brief</h2>
              <StatusBadge value={report?.priority ?? "NORMAL"} />
            </div>
            <h3 style={{ fontFamily: "Georgia,serif", fontSize: 22, fontWeight: 500 }}>
              {report?.primaryBottleneck}
            </h3>
            <p className="subtitle" style={{ lineHeight: 1.7 }}>
              {report?.summary}
            </p>
            {report?.anomalies.map((anomaly) => (
              <div className="activity" key={anomaly.message}>
                <span className="activity-dot" />
                <div>
                  <strong>{anomaly.severity}</strong>
                  <br />
                  <span>{anomaly.message}</span>
                </div>
                <ChevronRight size={13} />
              </div>
            ))}
          </section>
          <section className="card">
            <div className="section-head">
              <h2>Current priorities</h2>
              <span className="link">Maximum 5</span>
            </div>
            {report?.recommendations.map((rec) => (
              <div
                className="attention-row"
                style={{ gridTemplateColumns: "110px 1fr 90px 24px" }}
                key={rec.id}
              >
                <StatusBadge value={rec.priority} />
                <div className="signal">
                  <strong>{rec.action}</strong>
                  <small>{rec.evidence}</small>
                </div>
                <span style={{ fontSize: 10 }}>{rec.department}</span>
                <ChevronRight size={14} />
              </div>
            ))}
            {!report?.recommendations.length ? (
              <div className="empty-state">
                <CheckCircle2 size={24} style={{ margin: "0 auto 8px" }} />
                <strong>No intervention required</strong>Performance is within expected
                creator-relative ranges.
              </div>
            ) : null}
          </section>
          <section className="card">
            <div className="section-head">
              <h2>Content intelligence</h2>
              <a className="link" href="/content">
                Open content workspace
              </a>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Format</th>
                    <th>Franchise</th>
                    <th>Multiplier</th>
                    <th>Signal</th>
                  </tr>
                </thead>
                <tbody>
                  {contentPerformance.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <strong>{item.title}</strong>
                      </td>
                      <td>{item.franchise}</td>
                      <td>{item.multiplier.toFixed(2)}×</td>
                      <td>
                        <StatusBadge value={item.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
        <aside className="grid">
          <section className="card card-pad">
            <h2>Operating state</h2>
            <div className="stat-list">
              <div className="stat-line">
                <span>Contract</span>
                <StatusBadge value="SUCCEEDED" label="SIGNED" />
              </div>
              <div className="stat-line">
                <span>Root owner</span>
                <strong>Creator</strong>
              </div>
              <div className="stat-line">
                <span>Payout control</span>
                <strong>Creator controlled</strong>
              </div>
              <div className="stat-line">
                <span>MFA</span>
                <StatusBadge value="SUCCEEDED" label="ENABLED" />
              </div>
              <div className="stat-line">
                <span>Open tasks</span>
                <strong>{creatorTasks.length}</strong>
              </div>
            </div>
          </section>
          <section className="card card-pad">
            <h2>Brand dossier</h2>
            <div className="stat-list">
              <div className="stat-line">
                <span>Known for</span>
                <strong>Relatable POV</strong>
              </div>
              <div className="stat-line">
                <span>Primary audience</span>
                <strong>Women 21–34</strong>
              </div>
              <div className="stat-line">
                <span>Tone</span>
                <strong>Warm, direct</strong>
              </div>
              <div className="stat-line">
                <span>Truth items</span>
                <strong>14 approved</strong>
              </div>
              <div className="stat-line">
                <span>Boundaries</span>
                <strong>6 active</strong>
              </div>
            </div>
          </section>
          <section className="card card-pad">
            <h2>Data quality</h2>
            <p className="subtitle" style={{ lineHeight: 1.6 }}>
              Social metrics measured. Revenue data imported from the deterministic mock provider.
              Attribution is partially measured.
            </p>
          </section>
        </aside>
      </div>
    </main>
  );
}
