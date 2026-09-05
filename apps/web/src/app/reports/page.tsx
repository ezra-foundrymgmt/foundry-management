"use client";
import { useEffect, useState } from "react";
import {
  HEALTH_BANDS,
  WORK_DEPARTMENTS,
  WORK_PRIORITIES,
  creators,
  reports,
  type DailyReport,
} from "@creatoros/domain";
import { Check, ListChecks } from "lucide-react";
import { z } from "zod";
import { DemoStrip, PageHeader } from "@/components/page-header";
import { LiveEmpty } from "@/components/live-empty";
import { useDemoMode } from "@/components/mode-provider";
import { StatusBadge } from "@/components/status-badge";
export default function ReportsPage() {
  const demo = useDemoMode();
  const [reportRecords, setReportRecords] = useState<
    Array<DailyReport & { creatorName: string; coverage: ReportCoverage | null }>
  >(
    demo
      ? reports.map((report) => ({
          ...report,
          creatorName:
            creators.find((item) => item.id === report.creatorId)?.stageName ?? "Creator",
          // Seed reports carry no data-quality record, and inventing one would
          // make demo mode assert coverage nobody measured.
          coverage: null,
        }))
      : [],
  );
  const [created, setCreated] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (demo) return;
    void fetch("/api/reports/daily")
      .then((response) => response.json())
      .then((body: unknown) => {
        const envelope = z.object({ data: z.array(z.unknown()) }).safeParse(body);
        if (!envelope.success) return;
        // Parsed one report at a time rather than as a single z.array(...): a
        // report the client schema can't yet represent -- an added enum value,
        // a shape change -- used to fail the whole array's parse and blank
        // the entire org's report inbox for every creator, not just the one
        // report that didn't fit. One bad report is now dropped and logged,
        // not a reason to hide everyone else's.
        const parsedReports = envelope.data.data.flatMap((raw) => {
          const result = liveReportSchema.safeParse(raw);
          if (!result.success) {
            console.warn("Skipping a daily report the client could not parse", result.error);
            return [];
          }
          return [result.data];
        });
        setReportRecords(
          parsedReports.map((report) => ({
            id: report.id,
            creatorId: report.creator_id,
            creatorName: report.creators?.stage_name ?? "Creator",
            reportDate: report.report_date,
            status: "READY" as const,
            healthBand: report.health_status ?? "WATCH",
            summary: report.summary,
            primaryBottleneck: report.primary_bottleneck ?? "No primary bottleneck",
            priority: report.priority ?? "NORMAL",
            metrics: report.metrics_json,
            // The producer computes these and stores them under
            // data_quality_json.comparisons. This was the literal `{}` that
            // left every live report showing no figures at all.
            comparisons: report.data_quality_json?.comparisons ?? {},
            coverage: report.data_quality_json
              ? {
                  windowDays: report.data_quality_json.currentWindowDays ?? null,
                  revenueDays: report.data_quality_json.revenueDays ?? null,
                  socialDays: report.data_quality_json.socialDays ?? null,
                  socialPosts: report.data_quality_json.socialPosts ?? null,
                  incomparable: report.data_quality_json.incomparableDimensions ?? [],
                  dataConfidence: report.data_quality_json.dataConfidence ?? null,
                }
              : null,
            anomalies: report.anomalies_json,
            recommendations: report.recommendations_json.map((item, index) => ({
              id: item.id ?? `${report.id}-${index}`,
              department: item.department,
              action: item.action,
              evidence: "CreatorOS report",
              priority: item.priority,
              suggestedOwner: "Assigned team",
              dueInDays: 3,
              confidence: "MEASURED" as const,
              sourceRule: report.data_quality_json?.ruleId ?? "UNKNOWN",
            })),
            ruleId: report.data_quality_json?.ruleId ?? "UNKNOWN",
            provider: "RULES" as const,
          })),
        );
      });
  }, [demo]);

  async function createTasks(reportId: string) {
    if (demo) {
      setCreated((current) => (current.includes(reportId) ? current : [...current, reportId]));
      return;
    }
    const response = await fetch(`/api/reports/${reportId}/tasks`, { method: "POST" });
    const body = (await response.json()) as { error?: string; createdOrExisting?: number };
    if (!response.ok) {
      setMessage(body.error ?? "Task creation failed");
      return;
    }
    /**
     * A report with no recommendations is the ordinary result of a stable
     * creator, and the route answers 200 with a count of zero. The button
     * still flipped to "Tasks created", which is a claim that work was
     * assigned when the Tasks page holds nothing new.
     */
    if (!body.createdOrExisting) {
      setMessage("This report has no recommendations, so no tasks were created.");
      return;
    }
    setMessage("");
    setCreated((current) => (current.includes(reportId) ? current : [...current, reportId]));
  }
  return (
    <main className="page">
      <DemoStrip />
      <PageHeader
        eyebrow="Daily intelligence"
        title="Report inbox"
        subtitle="Exception-led operating reports generated by explainable rules before optional AI enrichment."
      />
      {message ? (
        <div className="demo-strip" role="status">
          {message}
        </div>
      ) : null}
      {reportRecords.length === 0 ? (
        <LiveEmpty
          title="No reports generated yet"
          hint="Daily reports appear here once a creator has a frozen baseline and measured metrics to compare against it."
        />
      ) : (
      <div className="grid">
        {reportRecords.map((report) => {
          const made = created.includes(report.id);
          return (
            <article className="card card-pad" key={report.id}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 18,
                  alignItems: "flex-start",
                }}
              >
                <div>
                  <div className="eyebrow">
                    {report.reportDate} · {report.ruleId}
                  </div>
                  <h2 style={{ fontFamily: "Georgia,serif", fontSize: 23, marginTop: 4 }}>
                    {report.creatorName}
                  </h2>
                  <StatusBadge value={report.healthBand} />
                </div>
                <div className="actions">
                  <button
                    className="button"
                    onClick={() => void createTasks(report.id)}
                    // Offering the action on a report with nothing to create is
                    // what made "Tasks created" appear over an empty Tasks page.
                    disabled={made || report.recommendations.length === 0}
                  >
                    {made ? (
                      <>
                        <Check size={14} /> Tasks created
                      </>
                    ) : report.recommendations.length === 0 ? (
                      <>No recommendations</>
                    ) : (
                      <>
                        <ListChecks size={14} /> Create recommended tasks
                      </>
                    )}
                  </button>
                  <a className="button primary" href={`/creators/${report.creatorId}`}>
                    Open creator
                  </a>
                </div>
              </div>
              <div style={{ marginTop: 18 }}>
                <span className="eyebrow">
                  THIS WINDOW VS {report.creatorName.toUpperCase()}&apos;S OWN BASELINE
                </span>
                <div style={{ marginTop: 8 }}>
                  <MetricsTable
                    metrics={report.metrics}
                    comparisons={report.comparisons}
                    coverage={report.coverage}
                  />
                </div>
                <CoverageNote coverage={report.coverage} />
              </div>
              <div className="grid detail-grid" style={{ marginTop: 18 }}>
                <div>
                  <span className="eyebrow">PRIMARY BOTTLENECK</span>
                  <h3 style={{ marginTop: 6 }}>{report.primaryBottleneck}</h3>
                  <p className="subtitle">{report.summary}</p>
                </div>
                <div>
                  <span className="eyebrow">SIGNALS</span>
                  {report.anomalies.length ? (
                    report.anomalies.map((item) => (
                      <p className="subtitle" style={{ marginTop: 6 }} key={item.message}>
                        • {item.message}
                      </p>
                    ))
                  ) : (
                    <p className="subtitle" style={{ marginTop: 6 }}>
                      No material anomaly detected.
                    </p>
                  )}
                </div>
                <div>
                  <span className="eyebrow">NEXT ACTIONS</span>
                  {report.recommendations.slice(0, 3).map((rec) => (
                    <p className="subtitle" style={{ marginTop: 6 }} key={rec.id}>
                      • {rec.department}: {rec.action}
                    </p>
                  ))}
                </div>
              </div>
            </article>
          );
        })}
      </div>
      )}
    </main>
  );
}

const liveReportSchema = z.object({
  id: z.string().uuid(),
  creator_id: z.string().uuid(),
  creators: z.object({ stage_name: z.string() }).nullable().optional(),
  report_date: z.string(),
  // Every band in the canonical list, including UNKNOWN -- the value
  // healthBand() (packages/domain/src/health-score.ts) returns for a
  // creator with no measured score yet. Missing it here meant a single
  // freshly onboarded creator's report -- the state every new creator
  // starts in -- failed this report's parse and, before parsing moved to
  // one report at a time, blanked the whole org's inbox for it.
  health_status: z.enum(HEALTH_BANDS).nullable(),
  summary: z.string(),
  primary_bottleneck: z.string().nullable(),
  priority: z.enum(["CRITICAL", "HIGH", "NORMAL"]).nullable(),
  anomalies_json: z.array(
    z.object({ severity: z.enum(["CRITICAL", "WARNING", "OPPORTUNITY"]), message: z.string() }),
  ),
  recommendations_json: z.array(
    z.object({
      id: z.string().optional(),
      department: z.enum(WORK_DEPARTMENTS),
      priority: z.enum(WORK_PRIORITIES),
      action: z.string(),
    }),
  ),
  // The real per-report metrics and the rule that produced the report
  // (apps/web/src/lib/daily-report.ts writes both into the row -- metrics
  // under metrics_json, the rule id under data_quality_json.ruleId). The API
  // route already selects both; only this page was ignoring them in favor of
  // an all-zero metrics object and the literal string "DATABASE".
  metrics_json: z.object({
    date: z.string(),
    reach: z.coerce.number(),
    profileVisits: z.coerce.number(),
    outboundClicks: z.coerce.number(),
    newSubscribers: z.coerce.number(),
    firstBuyers: z.coerce.number(),
    revenue: z.coerce.number(),
  }),
  /**
   * The report's own account of what it compared and how much it measured.
   *
   * `produceDailyCreatorReport` has written all of this since the producer was
   * built; the page read one field out of it (`ruleId`) and threw the rest
   * away, then rendered `comparisons: {}` — so a report whose entire purpose is
   * "here is how this creator is doing against her own baseline" displayed no
   * number of any kind. Every field is optional because reports stored before
   * a given field existed must still render.
   */
  data_quality_json: z
    .object({
      ruleId: z.string().optional(),
      comparisons: z.record(z.string(), z.number().nullable()).optional(),
      revenueDays: z.coerce.number().optional(),
      socialDays: z.coerce.number().optional(),
      socialPosts: z.coerce.number().optional(),
      currentWindowDays: z.coerce.number().optional(),
      incomparableDimensions: z.array(z.string()).optional(),
      dataConfidence: z.string().optional(),
    })
    .nullable()
    .optional(),
});

/** What the report says about its own coverage. Null for demo-mode reports. */
interface ReportCoverage {
  windowDays: number | null;
  revenueDays: number | null;
  socialDays: number | null;
  socialPosts: number | null;
  incomparable: string[];
  dataConfidence: string | null;
}

/**
 * The rows of the comparison table, in the order an operator reads them:
 * audience first, then acquisition, then money.
 *
 * `comparisonKey` is the key the rules engine writes into `comparisons`
 * (packages/domain/src/revenue-diagnostic.ts) — deliberately not the same
 * vocabulary as the metric names, which is part of why this never got wired.
 * `dimension` is the name used by `incomparableDimensions`, which is what
 * separates "did not move" from "nobody measured it".
 */
const METRIC_ROWS: ReadonlyArray<{
  label: string;
  dimension: keyof DailyReport["metrics"] | null;
  comparisonKey: string | null;
  format: "count" | "money" | "rate";
}> = [
  { label: "Reach", dimension: "reach", comparisonKey: "reach", format: "count" },
  { label: "Profile visits", dimension: "profileVisits", comparisonKey: null, format: "count" },
  { label: "Outbound clicks", dimension: "outboundClicks", comparisonKey: null, format: "count" },
  {
    label: "New subscribers",
    dimension: "newSubscribers",
    comparisonKey: "acquisition",
    format: "count",
  },
  { label: "First buyers", dimension: "firstBuyers", comparisonKey: null, format: "count" },
  { label: "First-purchase rate", dimension: null, comparisonKey: "firstPurchase", format: "rate" },
  { label: "Revenue", dimension: "revenue", comparisonKey: "revenue", format: "money" },
];

const DIMENSIONS_BY_SOURCE: Record<string, "social" | "revenue"> = {
  reach: "social",
  profileVisits: "social",
  outboundClicks: "social",
  newSubscribers: "revenue",
  firstBuyers: "revenue",
  revenue: "revenue",
};

function formatMetric(value: number, format: "count" | "money" | "rate"): string {
  if (format === "money")
    return value.toLocaleString(undefined, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    });
  return Math.round(value).toLocaleString();
}

/** A signed percentage, or the reason there is no percentage to show. */
function formatChange(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "no comparison";
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(0)}%`;
}

function changeTone(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "var(--muted)";
  if (value >= 5) return "var(--good, #1a7f4b)";
  if (value <= -5) return "var(--bad, #b3261e)";
  return "inherit";
}

/**
 * The comparison table for one report.
 *
 * "Not measured" and "no comparison" are different statements and are shown as
 * different things: the first means nothing was ingested for that dimension in
 * this window, the second means it was measured but the baseline holds no
 * comparable figure. Neither is ever rendered as a 0 or a 0%.
 */
function MetricsTable({
  metrics,
  comparisons,
  coverage,
}: {
  metrics: DailyReport["metrics"];
  comparisons: Record<string, number | null>;
  coverage: ReportCoverage | null;
}) {
  const incomparable = new Set(coverage?.incomparable ?? []);
  const firstPurchaseRate =
    metrics.newSubscribers > 0 ? (metrics.firstBuyers / metrics.newSubscribers) * 100 : null;
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" }}>
      <tbody>
        {METRIC_ROWS.map((row) => {
          const unmeasured = row.dimension !== null && incomparable.has(row.dimension);
          const value =
            row.dimension === null
              ? firstPurchaseRate
              : (metrics[row.dimension] as number | undefined);
          const change = row.comparisonKey === null ? undefined : comparisons[row.comparisonKey];
          return (
            <tr key={row.label} style={{ borderTop: "1px solid var(--line, #e6e2da)" }}>
              <td style={{ padding: "6px 0" }} className="subtitle">
                {row.label}
              </td>
              <td style={{ padding: "6px 0", textAlign: "right", fontWeight: 600 }}>
                {unmeasured || value === undefined || value === null
                  ? "not measured"
                  : row.format === "rate"
                    ? `${value.toFixed(0)}%`
                    : formatMetric(value, row.format)}
              </td>
              <td
                style={{
                  padding: "6px 0 6px 14px",
                  textAlign: "right",
                  color: unmeasured ? "var(--muted)" : changeTone(change),
                  whiteSpace: "nowrap",
                }}
              >
                {row.comparisonKey === null ? "" : unmeasured ? "—" : formatChange(change)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * One line stating how much of the window the figures above actually cover.
 *
 * Without it a partially entered week and a fully entered week look identical,
 * which is precisely the reading that made a two-day revenue total look like a
 * collapse.
 */
function CoverageNote({ coverage }: { coverage: ReportCoverage | null }) {
  if (!coverage) return null;
  const parts: string[] = [];
  if (coverage.windowDays !== null) parts.push(`${coverage.windowDays}-day window`);
  if (coverage.revenueDays !== null)
    parts.push(
      `revenue entered for ${coverage.revenueDays} ${coverage.revenueDays === 1 ? "day" : "days"}`,
    );
  if (coverage.socialPosts === 0) parts.push("no social posts");
  else if (coverage.socialPosts !== null)
    parts.push(
      `${coverage.socialPosts} social ${coverage.socialPosts === 1 ? "post" : "posts"}` +
        (coverage.socialDays === null
          ? ""
          : ` across ${coverage.socialDays} ${coverage.socialDays === 1 ? "day" : "days"}`),
    );
  if (coverage.dataConfidence) parts.push(`confidence ${coverage.dataConfidence}`);
  if (parts.length === 0) return null;
  const unmeasuredSources = new Set(
    coverage.incomparable.map((dimension) => DIMENSIONS_BY_SOURCE[dimension]).filter(Boolean),
  );
  return (
    <p className="subtitle" style={{ marginTop: 10, fontSize: 12 }}>
      {parts.join(" · ")}
      {unmeasuredSources.size > 0
        ? ` · ${[...unmeasuredSources].join(" and ")} not compared this window`
        : ""}
    </p>
  );
}
