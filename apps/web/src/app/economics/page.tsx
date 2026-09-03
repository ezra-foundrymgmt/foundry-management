import { AccessDenied } from "@/components/access-denied";
import { DemoStrip, PageHeader } from "@/components/page-header";
import { LiveEmpty } from "@/components/live-empty";
import { MetricCard } from "@/components/metric-card";
import { StatusBadge } from "@/components/status-badge";
import { formatMoney, UNKNOWN_DISPLAY } from "@/lib/format";
import { isMockMode } from "@/lib/environment";
import { getLivePnlRows, type LivePnlRow } from "@/lib/live-data";
import { authorizePage } from "@/lib/page-access";

/**
 * Demo figures, shaped exactly like live rows so there is one render path.
 * Previously this page held a hardcoded table of three fictional creators and
 * rendered it in live mode too — a finance user on a real deployment would have
 * read invented contribution margins as Foundry's actual economics.
 */
const DEMO_ROWS: LivePnlRow[] = [
  {
    creatorId: "demo-ava",
    creator: "Ava Monroe",
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    receipts: 58320,
    commissionRate: 30,
    foundryRevenue: 17496,
    directCosts: 7510,
    contributionProfit: 9986,
    contributionMargin: 57.1,
  },
  {
    creatorId: "demo-madison",
    creator: "Madison Carter",
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    receipts: 42180,
    commissionRate: 30,
    foundryRevenue: 12654,
    directCosts: 7330,
    contributionProfit: 5324,
    contributionMargin: 42.1,
  },
  {
    creatorId: "demo-sarah",
    creator: "Sarah Vale",
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    receipts: 27740,
    commissionRate: 30,
    foundryRevenue: 8322,
    directCosts: 6510,
    contributionProfit: 1812,
    contributionMargin: 21.8,
  },
];

/** Sums only recorded values; all-null stays unknown rather than becoming zero. */
function total(rows: LivePnlRow[], field: keyof LivePnlRow): number | null {
  const values = rows
    .map((row) => row[field])
    .filter((value): value is number => typeof value === "number");
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function marginBand(margin: number): string {
  return margin >= 50 ? "GREEN" : margin >= 35 ? "WATCH" : "CRITICAL";
}

export default async function EconomicsPage() {
  const access = await authorizePage("finance.read");
  if (!access.allowed)
    return <AccessDenied title="Unit economics" permission="finance.read" reason={access.reason} />;

  const mock = isMockMode();
  const rows = mock ? DEMO_ROWS : await getLivePnlRows();

  const receipts = total(rows, "receipts");
  const foundryRevenue = total(rows, "foundryRevenue");
  const contributionProfit = total(rows, "contributionProfit");
  // Derived from the totals, not averaged from per-creator margins, and unknown
  // when either side of the ratio is unknown.
  const margin =
    contributionProfit !== null && foundryRevenue !== null && foundryRevenue > 0
      ? Math.round((contributionProfit / foundryRevenue) * 1000) / 10
      : null;

  return (
    <main className="page">
      <DemoStrip />
      <PageHeader
        eyebrow="Unit economics"
        title="Creator P&L"
        subtitle="Foundry revenue, direct fulfillment cost, and contribution profit—not roster size—drive portfolio health."
      />
      <div className="grid metrics-grid">
        <MetricCard
          label="Creator receipts"
          value={formatMoney(receipts)}
          context="recorded periods"
        />
        <MetricCard
          label="Foundry revenue"
          value={formatMoney(foundryRevenue)}
          context="recorded periods"
        />
        <MetricCard
          label="Contribution profit"
          value={formatMoney(contributionProfit)}
          context="after direct costs"
        />
        <MetricCard
          label="Contribution margin"
          value={margin === null ? UNKNOWN_DISPLAY : `${margin}%`}
          context="target ≥ 50%"
        />
      </div>

      {rows.length === 0 ? (
        <LiveEmpty
          title="No P&L periods recorded"
          hint="Creator activation opens a period; figures appear once receipts and costs are recorded."
        />
      ) : (
        <section className="card">
          <div className="section-head">
            <h2>Contribution economics</h2>
            <span className="subtitle">{rows.length} recorded periods</span>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Creator</th>
                  <th>Period</th>
                  <th>Receipts</th>
                  <th>Commission</th>
                  <th>Foundry revenue</th>
                  <th>Direct cost</th>
                  <th>Contribution profit</th>
                  <th>Margin</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.creatorId}-${row.periodStart}`}>
                    <td>
                      <strong>{row.creator}</strong>
                    </td>
                    <td style={{ fontSize: 10, color: "var(--ink-soft)" }}>
                      {row.periodStart} → {row.periodEnd}
                    </td>
                    <td>{formatMoney(row.receipts)}</td>
                    <td>
                      {row.commissionRate === null ? UNKNOWN_DISPLAY : `${row.commissionRate}%`}
                    </td>
                    <td>{formatMoney(row.foundryRevenue)}</td>
                    <td>{formatMoney(row.directCosts)}</td>
                    <td>{formatMoney(row.contributionProfit)}</td>
                    <td>
                      {row.contributionMargin === null ? (
                        <span style={{ color: "var(--ink-soft)" }}>{UNKNOWN_DISPLAY}</span>
                      ) : (
                        <StatusBadge
                          value={marginBand(row.contributionMargin)}
                          label={`${row.contributionMargin}%`}
                        />
                      )}
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
