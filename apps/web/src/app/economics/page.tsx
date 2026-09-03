import { AccessDenied } from "@/components/access-denied";
import { authorizePage } from "@/lib/page-access";
import { creators } from "@creatoros/domain";
import { DemoStrip, PageHeader } from "@/components/page-header";
import { MetricCard } from "@/components/metric-card";
import { StatusBadge } from "@/components/status-badge";
const rows = [
  {
    creator: "Ava Monroe",
    receipts: 58320,
    rate: 30,
    foundry: 17496,
    costs: 7510,
    profit: 9986,
    margin: 57.1,
  },
  {
    creator: "Madison Carter",
    receipts: 42180,
    rate: 30,
    foundry: 12654,
    costs: 7330,
    profit: 5324,
    margin: 42.1,
  },
  {
    creator: "Sarah Vale",
    receipts: 27740,
    rate: 30,
    foundry: 8322,
    costs: 6510,
    profit: 1812,
    margin: 21.8,
  },
];
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
export default async function EconomicsPage() {
  const access = await authorizePage("finance.read");
  if (!access.allowed)
    return <AccessDenied title="Unit economics" permission="finance.read" reason={access.reason} />;
  const receipts = creators.reduce((sum, item) => sum + item.monthlyRevenue, 0);
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
          value={money.format(receipts)}
          change={9.4}
          context="current period"
        />
        <MetricCard
          label="Foundry revenue"
          value="$38,472"
          change={9.4}
          context="30% blended commission"
        />
        <MetricCard
          label="Contribution profit"
          value="$17,122"
          change={6.8}
          context="after direct costs"
        />
        <MetricCard
          label="Contribution margin"
          value="44.5%"
          change={-1.1}
          context="target ≥ 50%"
        />
      </div>
      <section className="card">
        <div className="section-head">
          <h2>September contribution economics</h2>
          <span className="subtitle">Draft · Through Sep 2</span>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Creator</th>
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
                <tr key={row.creator}>
                  <td>
                    <strong>{row.creator}</strong>
                  </td>
                  <td>{money.format(row.receipts)}</td>
                  <td>{row.rate}%</td>
                  <td>{money.format(row.foundry)}</td>
                  <td>{money.format(row.costs)}</td>
                  <td>{money.format(row.profit)}</td>
                  <td>
                    <StatusBadge
                      value={row.margin >= 50 ? "GREEN" : row.margin >= 35 ? "WATCH" : "CRITICAL"}
                      label={`${row.margin}%`}
                    />
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
