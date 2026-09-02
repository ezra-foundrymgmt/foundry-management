import Link from "next/link";
import { creators } from "@creatoros/domain";
import { Filter, Plus, Search } from "lucide-react";
import { DemoStrip, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { isMockMode } from "@/lib/environment";
import { getLiveCreators } from "@/lib/live-data";

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
export default async function CreatorsPage() {
  const creatorRecords = isMockMode() ? creators : await getLiveCreators();
  return (
    <main className="page">
      <DemoStrip />
      <PageHeader
        eyebrow="Portfolio"
        title="Creators"
        subtitle="The canonical operating record for every creator business managed by Foundry."
        actions={
          <button className="button primary" disabled title="Use prospect conversion in live mode">
            <Plus size={14} /> Add creator
          </button>
        }
      />
      <section className="card">
        <div className="table-toolbar">
          <Search size={15} />
          <input className="input toolbar-search" placeholder="Search creator or ID…" />
          <button className="button" disabled title="Saved filters require the live database">
            <Filter size={13} /> Filters
          </button>
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-soft)" }}>
            {creatorRecords.length} creators
          </span>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Creator</th>
                <th>Status</th>
                <th>Monthly receipts</th>
                <th>30d trend</th>
                <th>Health</th>
                <th>Buffer</th>
                <th>Owner</th>
                <th>Integrations</th>
              </tr>
            </thead>
            <tbody>
              {creatorRecords.map((creator) => (
                <tr key={creator.id}>
                  <td>
                    <Link href={`/creators/${creator.id}`}>
                      <strong>{creator.stageName}</strong>
                      <br />
                      <span style={{ fontSize: 10, color: "var(--ink-soft)" }}>
                        {creator.creatorNumber}
                      </span>
                    </Link>
                  </td>
                  <td>
                    <StatusBadge value={creator.status} />
                  </td>
                  <td>{money.format(creator.monthlyRevenue)}</td>
                  <td className={creator.revenueTrendPercent >= 0 ? "trend-up" : "trend-down"}>
                    {creator.revenueTrendPercent > 0 ? "+" : ""}
                    {creator.revenueTrendPercent}%
                  </td>
                  <td>
                    <StatusBadge
                      value={creator.healthBand}
                      label={`${creator.healthScore} · ${creator.healthBand}`}
                    />
                  </td>
                  <td>{creator.contentBufferDays} days</td>
                  <td>{creator.owner}</td>
                  <td>
                    <StatusBadge value={creator.integrationHealth} />
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
