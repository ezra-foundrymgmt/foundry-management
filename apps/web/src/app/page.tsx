import Link from "next/link";
import { ArrowRight, CircleAlert } from "lucide-react";
import { creators as demoCreators, reports as demoReports } from "@creatoros/domain";
import { AccessDenied } from "@/components/access-denied";
import { DemoStrip, PageHeader } from "@/components/page-header";
import { LiveEmpty } from "@/components/live-empty";
import { MetricCard } from "@/components/metric-card";
import { StatusBadge } from "@/components/status-badge";
import {
  formatMoney,
  formatScore,
  formatTrend,
  trendClassName,
  UNKNOWN_DISPLAY,
} from "@/lib/format";
import { isMockMode } from "@/lib/environment";
import {
  getLiveCreators,
  getLiveIncidents,
  getLiveReports,
  getLiveTasks,
  getLiveWorkflowRuns,
  type LiveCreatorRow,
  type LiveReportRow,
} from "@/lib/live-data";
import { authorizePage } from "@/lib/page-access";

interface Pulse {
  openTasks: number;
  overdueTasks: number;
  failedWorkflows: number;
  openIncidents: number;
}

function sumOrNull(values: Array<number | null>): number | null {
  const recorded = values.filter((value): value is number => typeof value === "number");
  return recorded.length ? recorded.reduce((total, value) => total + value, 0) : null;
}

function averageOrNull(values: Array<number | null>): number | null {
  const recorded = values.filter((value): value is number => typeof value === "number");
  return recorded.length
    ? Math.round(recorded.reduce((total, value) => total + value, 0) / recorded.length)
    : null;
}

export default async function CommandCenterPage() {
  const access = await authorizePage("creator.read");
  if (!access.allowed)
    return <AccessDenied title="Command Center" permission="creator.read" reason={access.reason} />;

  const mock = isMockMode();

  let creators: LiveCreatorRow[];
  let reportRows: Array<
    Pick<LiveReportRow, "id" | "creatorId" | "creatorName" | "summary" | "priority">
  >;
  // creatorId -> the constraint its most recent report identified.
  let bottlenecks: Map<string, string>;
  let pulse: Pulse;

  if (mock) {
    creators = demoCreators.map((creator) => ({
      id: creator.id,
      creatorNumber: creator.creatorNumber,
      stageName: creator.stageName,
      status: creator.status,
      monthlyRevenue: creator.monthlyRevenue,
      revenueTrendPercent: creator.revenueTrendPercent,
      healthScore: creator.healthScore,
      healthBand: creator.healthBand,
      contentBufferDays: creator.contentBufferDays,
      owner: creator.owner,
      integrationHealth: creator.integrationHealth,
      // Fixtures carry no triage decision; untriaged is the honest value.
      priority: null,
    }));
    bottlenecks = new Map(
      demoReports.map((report) => [report.creatorId, report.primaryBottleneck]),
    );
    reportRows = demoReports.map((report) => ({
      id: report.id,
      creatorId: report.creatorId,
      creatorName:
        demoCreators.find((item) => item.id === report.creatorId)?.stageName ?? "Creator",
      summary: report.summary,
      priority: report.priority,
    }));
    pulse = { openTasks: 4, overdueTasks: 1, failedWorkflows: 0, openIncidents: 1 };
  } else {
    // Every number below is counted from real rows. Nothing is a fixed figure —
    // the previous version hardcoded contribution profit, portfolio health,
    // scale readiness and the whole operating pulse.
    const [liveCreators, liveReports, liveTasks, liveRuns, liveIncidents] = await Promise.all([
      getLiveCreators(),
      getLiveReports(),
      getLiveTasks(),
      getLiveWorkflowRuns(),
      getLiveIncidents(),
    ]);
    creators = liveCreators;
    reportRows = liveReports.slice(0, 5);
    // Reports come back newest first, so the first entry per creator is current.
    bottlenecks = new Map();
    for (const report of liveReports)
      if (report.primaryBottleneck && !bottlenecks.has(report.creatorId))
        bottlenecks.set(report.creatorId, report.primaryBottleneck);
    const now = Date.now();
    pulse = {
      openTasks: liveTasks.filter((task) => task.status !== "DONE").length,
      overdueTasks: liveTasks.filter(
        (task) =>
          task.status !== "DONE" && task.dueAt !== null && new Date(task.dueAt).getTime() < now,
      ).length,
      failedWorkflows: liveRuns.filter((run) => run.status === "FAILED").length,
      openIncidents: liveIncidents.filter((incident) => incident.status !== "RESOLVED").length,
    };
  }

  const totalRevenue = sumOrNull(creators.map((creator) => creator.monthlyRevenue));
  const portfolioHealth = averageOrNull(creators.map((creator) => creator.healthScore));
  /**
   * Who the founder should look at first.
   *
   * Health was the only input, and `current_health_status` has no writer, so
   * every creator reads UNKNOWN and this list was structurally always empty --
   * the panel could never appear. Human triage is the one signal that is
   * genuinely populated today, so a creator someone marked CRITICAL or HIGH
   * belongs here on that basis alone. Health still counts once it is computed;
   * this does not replace it, it stops the list depending on a column nothing
   * writes.
   */
  const urgentlyTriaged = new Set(["CRITICAL", "HIGH"]);
  const needAttention = creators.filter(
    (creator) =>
      (creator.healthBand !== "GREEN" && creator.healthBand !== "UNKNOWN") ||
      urgentlyTriaged.has(creator.priority ?? ""),
  );
  const lowBuffers = creators.filter(
    (creator) => creator.contentBufferDays !== null && creator.contentBufferDays < 10,
  ).length;

  return (
    <main className="page">
      <DemoStrip />
      <PageHeader
        eyebrow="Operating overview"
        title="Foundry Command Center"
        subtitle="What is happening, why it matters, and what needs to happen next."
        actions={
          <Link className="button primary" href="/reports">
            Review daily reports <ArrowRight size={14} />
          </Link>
        }
      />

      <section className="grid metrics-grid" aria-label="Portfolio summary">
        <MetricCard
          label="Creator receipts"
          value={formatMoney(totalRevenue)}
          context="trailing 30 days"
        />
        <MetricCard label="Creators" value={String(creators.length)} context="not archived" />
        <MetricCard
          label="Portfolio health"
          value={portfolioHealth === null ? UNKNOWN_DISPLAY : `${portfolioHealth} / 100`}
          context={`${needAttention.length} need attention`}
        />
        <MetricCard
          label="Open incidents"
          value={String(pulse.openIncidents)}
          context="unresolved"
        />
      </section>

      {creators.length === 0 ? (
        <LiveEmpty
          title="No creators yet"
          hint="Convert a signed prospect to a creator and the portfolio appears here."
        />
      ) : (
        <div className="grid dashboard-grid">
          <div className="grid">
            {needAttention.length ? (
              <section className="card">
                <div className="section-head">
                  <h2>Requires attention</h2>
                  <span className="badge red">
                    <CircleAlert size={11} /> {needAttention.length} CREATORS
                  </span>
                </div>
                <div className="attention-list">
                  {needAttention.map((creator) => (
                    <Link
                      href={`/creators/${creator.id}`}
                      className="attention-row"
                      key={creator.id}
                    >
                      <div className="creator-cell">
                        <strong>{creator.stageName}</strong>
                        <span>
                          {creator.creatorNumber} · {creator.owner ?? "Unassigned"}
                        </span>
                      </div>
                      <div className="signal">
                        <strong>{bottlenecks.get(creator.id) ?? "No report yet"}</strong>
                      </div>
                      <div className="mini-stat">
                        <span>Health</span>
                        <strong>{formatScore(creator.healthScore)}</strong>
                      </div>
                      {/* Why this creator is on the list. Until health is
                          computed, triage is usually the reason. */}
                      {creator.priority ? <StatusBadge value={creator.priority} /> : null}
                      <StatusBadge value={creator.healthBand} />
                      <ArrowRight size={15} />
                    </Link>
                  ))}
                </div>
              </section>
            ) : null}

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
                        <td>{formatMoney(creator.monthlyRevenue)}</td>
                        <td className={trendClassName(creator.revenueTrendPercent)}>
                          {formatTrend(creator.revenueTrendPercent)}
                        </td>
                        <td>
                          <StatusBadge value={creator.healthBand} />
                        </td>
                        <td>
                          {creator.contentBufferDays === null
                            ? UNKNOWN_DISPLAY
                            : `${creator.contentBufferDays} days`}
                        </td>
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
                {reportRows.length ? (
                  reportRows.map((report) => (
                    <div className="report-item" key={report.id}>
                      <div className="report-item-top">
                        <strong>{report.creatorName}</strong>
                        <StatusBadge value={report.priority ?? "NORMAL"} />
                      </div>
                      <p>{report.summary}</p>
                    </div>
                  ))
                ) : (
                  <p className="subtitle" style={{ padding: 16 }}>
                    No reports generated yet.
                  </p>
                )}
              </div>
            </section>

            <section className="card card-pad">
              <h2>Operating pulse</h2>
              <div className="stat-list">
                <div className="stat-line">
                  <span>Open tasks</span>
                  <strong>{pulse.openTasks}</strong>
                </div>
                <div className="stat-line">
                  <span>Overdue tasks</span>
                  <strong className={pulse.overdueTasks > 0 ? "trend-down" : ""}>
                    {pulse.overdueTasks}
                  </strong>
                </div>
                <div className="stat-line">
                  <span>Failed workflows</span>
                  <strong className={pulse.failedWorkflows > 0 ? "trend-down" : ""}>
                    {pulse.failedWorkflows}
                  </strong>
                </div>
                <div className="stat-line">
                  <span>Low content buffers</span>
                  <strong>{lowBuffers}</strong>
                </div>
                <div className="stat-line">
                  <span>Open incidents</span>
                  <strong>{pulse.openIncidents}</strong>
                </div>
              </div>
            </section>
          </aside>
        </div>
      )}
    </main>
  );
}
