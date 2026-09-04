import { AccessDenied } from "@/components/access-denied";
import { authorizePage } from "@/lib/page-access";
import Link from "next/link";
import { creators, hasPermission } from "@creatoros/domain";
import { Filter, Plus, Search } from "lucide-react";
import { DemoStrip, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { isMockMode } from "@/lib/environment";
import { getLiveCreators } from "@/lib/live-data";

import {
  formatMoney,
  formatScore,
  formatTrend,
  trendClassName,
  UNKNOWN_DISPLAY,
} from "@/lib/format";
export default async function CreatorsPage() {
  const access = await authorizePage("creator.read");
  if (!access.allowed)
    return <AccessDenied title="Creators" permission="creator.read" reason={access.reason} />;
  const creatorRecords = isMockMode()
    ? creators.map((creator) => ({ ...creator, priority: null as string | null }))
    : await getLiveCreators();
  // Creators are only ever created by converting a prospect, so the button is
  // honest only for someone who can both reach that board and convert once
  // they are there. Gating on creator.read alone dead-ended fan_ops, editor,
  // finance and contractor at an access-denied page; gating on prospect.read
  // alone still sent analyst and viewer to a board where every convert control
  // is disabled.
  const canAddCreator =
    hasPermission(access.session.role, "prospect.read") &&
    hasPermission(access.session.role, "creator.create");

  return (
    <main className="page">
      <DemoStrip />
      <PageHeader
        eyebrow="Portfolio"
        title="Creators"
        subtitle="Every creator business Foundry manages."
        actions={
          canAddCreator ? (
            <Link className="button primary" href="/crm/prospects">
              <Plus size={14} /> Add creator
            </Link>
          ) : null
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
                <th>Priority</th>
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
                    {/* Ordered by this column: the roster now leads with what
                        a person actually triaged. */}
                    {creator.priority ? (
                      <StatusBadge value={creator.priority} />
                    ) : (
                      <span style={{ fontSize: 10, color: "var(--ink-soft)" }}>Not triaged</span>
                    )}
                  </td>
                  <td>
                    <StatusBadge value={creator.status} />
                  </td>
                  <td
                    title={creator.monthlyRevenue === null ? "No revenue data imported" : undefined}
                  >
                    {formatMoney(creator.monthlyRevenue)}
                  </td>
                  <td
                    className={trendClassName(creator.revenueTrendPercent)}
                    title={
                      creator.revenueTrendPercent === null
                        ? "Not enough history to compute a trend"
                        : undefined
                    }
                  >
                    {formatTrend(creator.revenueTrendPercent)}
                  </td>
                  <td>
                    <StatusBadge
                      value={creator.healthBand}
                      label={`${formatScore(creator.healthScore)} · ${creator.healthBand}`}
                    />
                  </td>
                  <td>
                    {creator.contentBufferDays === null
                      ? UNKNOWN_DISPLAY
                      : `${creator.contentBufferDays} days`}
                  </td>
                  <td>{creator.owner ?? "Unassigned"}</td>
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
