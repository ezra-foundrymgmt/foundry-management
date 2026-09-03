import { notFound } from "next/navigation";
import {
  creators as demoCreators,
  reports as demoReports,
  tasks as demoTasks,
} from "@creatoros/domain";
import { ArrowLeft } from "lucide-react";
import { AccessDenied } from "@/components/access-denied";
import { CreatorPriorityControl } from "@/components/creator-priority-control";
import { OnboardingButton } from "@/components/onboarding-button";
import { ReadinessPanel, type ReadinessState } from "@/components/readiness-panel";
import { StatusBadge } from "@/components/status-badge";
import {
  formatMoney,
  formatScore,
  formatTrend,
  trendClassName,
  UNKNOWN_DISPLAY,
} from "@/lib/format";
import { evaluateActivationReadiness } from "@/lib/activation-readiness";
import { isMockMode } from "@/lib/environment";
import { getLiveCreatorDetail, type LiveCreatorDetail } from "@/lib/live-data";
import { authorizePage } from "@/lib/page-access";

/** Builds the same shape from fixtures so there is a single render path. */
function demoDetail(creatorId: string): LiveCreatorDetail | null {
  const creator = demoCreators.find((item) => item.id === creatorId);
  if (!creator) return null;
  const report = demoReports.find((item) => item.creatorId === creator.id);
  return {
    creator: {
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
      contractStatus: "SIGNED",
      jurisdictionStatus: "PASSED",
      adultConfirmationStatus: "PASSED",
      startDate: "2026-09-01",
      timezone: "America/Los_Angeles",
      primaryPlatform: "Instagram",
      priority: null,
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
    latestReport: report
      ? {
          id: report.id,
          creatorId: creator.id,
          creatorName: creator.stageName,
          reportDate: report.reportDate,
          status: report.status,
          healthStatus: report.healthBand,
          summary: report.summary,
          primaryBottleneck: report.primaryBottleneck,
          priority: report.priority,
          provider: report.provider,
        }
      : null,
    tasks: demoTasks
      .filter((task) => task.creatorId === creator.id)
      .map((task) => ({
        id: task.id,
        title: task.title,
        creatorName: creator.stageName,
        department: task.department,
        priority: task.priority,
        status: task.status,
        dueAt: task.dueAt,
        sourceType: task.sourceType,
      })),
    brandProfile: {
      knownFor: "Relationship POV and lifestyle",
      positioning: "Approachable, high-consistency creator",
      niche: "Fitness & lifestyle",
    },
    boundaries: [
      { category: "Content", statement: "No face-visible gym content", itemType: "prohibited" },
    ],
    baselineFrozen: false,
  };
}

export default async function CreatorPage({ params }: { params: Promise<{ creatorId: string }> }) {
  const access = await authorizePage("creator.read");
  if (!access.allowed)
    return <AccessDenied title="Creator" permission="creator.read" reason={access.reason} />;

  const { creatorId } = await params;
  const mock = isMockMode();
  // In live mode this reads the database. Previously the page only ever looked
  // the id up in the seed fixtures, so every real creator 404'd.
  const detail = mock ? demoDetail(creatorId) : await getLiveCreatorDetail(creatorId);
  if (!detail) notFound();

  const { creator, latestReport, tasks, brandProfile, boundaries, baselineFrozen } = detail;

  // Evaluated against the records themselves, so this panel disagrees with the
  // creator status whenever the status is wrong. A failed evaluation says so
  // rather than defaulting to a reassuring answer.
  const readiness: ReadinessState = mock
    ? {
        evaluated: false,
        reason: "demo mode has no live records to evaluate against",
      }
    : await evaluateActivationReadiness({
        organizationId: access.session.organizationId,
        creatorId,
      })
        .then((result) => ({ evaluated: true, readiness: result }) as const)
        .catch((error: unknown) => ({
          evaluated: false as const,
          reason: error instanceof Error ? error.message : "readiness could not be read",
        }));

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
          <span className="eyebrow">{creator.creatorNumber}</span>
          <h1>{creator.stageName}</h1>
          <p className="subtitle">
            {creator.primaryPlatform ?? "Platform not recorded"} · {creator.owner ?? "Unassigned"} ·{" "}
            {creator.timezone ?? "Timezone not recorded"}
          </p>
        </div>
        <div className="actions">
          <StatusBadge value={creator.status} />
          <OnboardingButton />
        </div>
      </header>

      <section className="grid metrics-grid">
        <article className="card metric-card">
          <div className="metric-label">
            <span>Monthly receipts</span>
          </div>
          <div className="metric-value">{formatMoney(creator.monthlyRevenue)}</div>
          <div className={trendClassName(creator.revenueTrendPercent)}>
            {formatTrend(creator.revenueTrendPercent)} vs prior 30 days
          </div>
        </article>
        <article className="card metric-card">
          <div className="metric-label">
            <span>Health</span>
          </div>
          <div className="metric-value">{formatScore(creator.healthScore)}</div>
          <StatusBadge value={creator.healthBand} />
        </article>
        <article className="card metric-card">
          <div className="metric-label">
            <span>Content buffer</span>
          </div>
          <div className="metric-value">
            {creator.contentBufferDays === null
              ? UNKNOWN_DISPLAY
              : `${creator.contentBufferDays} days`}
          </div>
        </article>
        <article className="card metric-card">
          <div className="metric-label">
            <span>Integrations</span>
          </div>
          <div className="metric-value" style={{ fontSize: 18 }}>
            <StatusBadge value={creator.integrationHealth} />
          </div>
        </article>
        <CreatorPriorityControl
          creatorId={creator.id}
          priority={creator.priority}
          updatedAt={creator.updatedAt}
          readOnly={mock}
        />
      </section>

      <div className="grid dashboard-grid">
        <div className="grid">
          <ReadinessPanel state={readiness} />

          <section className="card card-pad">
            <h2>Latest daily report</h2>
            {latestReport ? (
              <>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
                  <StatusBadge value={latestReport.priority ?? "NORMAL"} />
                  <span style={{ fontSize: 11, color: "var(--ink-soft)" }}>
                    {latestReport.reportDate} · {latestReport.provider}
                  </span>
                </div>
                <p className="subtitle" style={{ marginTop: 10, lineHeight: 1.6 }}>
                  {latestReport.summary}
                </p>
                {latestReport.primaryBottleneck ? (
                  <p style={{ fontSize: 11, marginTop: 8 }}>
                    <strong>Constraint:</strong> {latestReport.primaryBottleneck}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="subtitle" style={{ marginTop: 8 }}>
                No report generated yet. Reports require a frozen baseline and imported metrics.
              </p>
            )}
          </section>

          <section className="card">
            <div className="section-head">
              <h2>Tasks</h2>
              <span className="subtitle">
                {tasks.filter((task) => task.status !== "DONE").length} open
              </span>
            </div>
            {tasks.length ? (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th>Department</th>
                      <th>Due</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.map((task) => (
                      <tr key={task.id}>
                        <td>
                          <strong>{task.title}</strong>
                        </td>
                        <td>{task.department ?? "Unassigned"}</td>
                        <td>
                          {task.dueAt ? new Date(task.dueAt).toLocaleDateString() : "No due date"}
                        </td>
                        <td>
                          <StatusBadge value={task.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="subtitle" style={{ padding: 16 }}>
                No tasks recorded for this creator.
              </p>
            )}
          </section>
        </div>

        <aside className="grid">
          <section className="card card-pad">
            <h2>Brand Dossier</h2>
            {/* Null means no dossier row exists — not an empty dossier. */}
            {brandProfile ? (
              <div className="stat-list">
                <div className="stat-line">
                  <span>Known for</span>
                  <strong>{brandProfile.knownFor ?? "Not recorded"}</strong>
                </div>
                <div className="stat-line">
                  <span>Niche</span>
                  <strong>{brandProfile.niche ?? "Not recorded"}</strong>
                </div>
                <div className="stat-line">
                  <span>Positioning</span>
                  <strong>{brandProfile.positioning ?? "Not recorded"}</strong>
                </div>
              </div>
            ) : (
              <p className="subtitle" style={{ marginTop: 8 }}>
                No Brand Dossier yet. Creator activation initialises one.
              </p>
            )}
          </section>

          <section className="card card-pad">
            <h2>Operating state</h2>
            <div className="stat-list">
              <div className="stat-line">
                <span>Contract</span>
                <strong>{creator.contractStatus ?? "Not recorded"}</strong>
              </div>
              <div className="stat-line">
                <span>Jurisdiction review</span>
                <strong>{creator.jurisdictionStatus ?? "Not recorded"}</strong>
              </div>
              <div className="stat-line">
                <span>Adult confirmation</span>
                <strong>{creator.adultConfirmationStatus ?? "Not recorded"}</strong>
              </div>
              <div className="stat-line">
                <span>Start date</span>
                <strong>{creator.startDate ?? "Not recorded"}</strong>
              </div>
              <div className="stat-line">
                <span>Baseline frozen</span>
                <strong>{baselineFrozen ? "Yes" : "No"}</strong>
              </div>
            </div>
          </section>

          <section className="card card-pad">
            <h2>Boundaries</h2>
            {boundaries.length ? (
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11, lineHeight: 1.7 }}>
                {boundaries.map((boundary, index) => (
                  <li key={`${boundary.category}-${index}`}>
                    <strong>{boundary.itemType}</strong> · {boundary.category}: {boundary.statement}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="subtitle">
                No boundaries recorded. Activation is blocked until they are collected.
              </p>
            )}
          </section>
        </aside>
      </div>
    </main>
  );
}
