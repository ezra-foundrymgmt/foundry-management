import { PIPELINE_STAGES, prospects } from "@creatoros/domain";
import { Filter, Plus, Search } from "lucide-react";
import { ConvertProspectButton } from "@/components/convert-prospect-button";
import { DemoStrip, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { isMockMode } from "@/lib/environment";
import { getLiveProspects } from "@/lib/live-data";

const visibleStages = ["FOLLOW_UP", "AUDIT", "DISCOVERY", "SIGNED"] as const;

export default async function ProspectsPage() {
  const prospectRecords = isMockMode() ? prospects : await getLiveProspects();
  return (
    <main className="page">
      <DemoStrip />
      <PageHeader
        eyebrow="Acquisition CRM"
        title="Prospects"
        subtitle="Qualify opportunities with a consistent fit model and preserve every relationship touchpoint."
        actions={
          <button
            className="button primary"
            disabled
            title="Demo mode is read-only for CRM records"
          >
            <Plus size={14} /> Add prospect
          </button>
        }
      />
      <div className="tabs">
        <span className="tab">Table</span>
        <span className="tab active">Pipeline</span>
        <span className="tab">Saved views</span>
      </div>
      <div className="table-toolbar card" style={{ marginBottom: 14 }}>
        <Search size={15} />
        <input
          className="input toolbar-search"
          placeholder="Search prospects…"
          aria-label="Search prospects"
        />
        <button
          className="button"
          disabled
          title="Interactive saved filters require the live database"
        >
          <Filter size={13} /> Filter
        </button>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-soft)" }}>
          {PIPELINE_STAGES.length} stages configured
        </span>
      </div>
      <section className="grid kanban" aria-label="Prospect pipeline">
        {visibleStages.map((stage) => {
          const items = prospectRecords.filter((prospect) => prospect.pipelineStage === stage);
          return (
            <div className="kanban-column" key={stage}>
              <div className="kanban-head">
                <span>{stage.replaceAll("_", " ")}</span>
                <span>{items.length}</span>
              </div>
              {items.length ? (
                items.map((prospect) => (
                  <article className="kanban-card" key={prospect.id}>
                    <strong>{prospect.stageName}</strong>
                    <p>
                      {prospect.niche} ·{" "}
                      {prospect.followerCountEstimate === null
                        ? "audience unknown"
                        : `${(prospect.followerCountEstimate / 1000).toFixed(0)}K est.`}
                    </p>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                      }}
                    >
                      <StatusBadge
                        value={prospect.fitTier}
                        label={`${prospect.fitScore} · ${prospect.fitTier}`}
                      />
                      <span style={{ fontSize: 10, color: "var(--ink-soft)" }}>
                        {prospect.owner}
                      </span>
                    </div>
                    {prospect.pipelineStage === "SIGNED" ? (
                      <div style={{ marginTop: 12 }}>
                        <ConvertProspectButton prospectId={prospect.id} />
                      </div>
                    ) : null}
                  </article>
                ))
              ) : (
                <div className="empty-state" style={{ padding: 24 }}>
                  <strong>No prospects</strong>Move qualified relationships here.
                </div>
              )}
            </div>
          );
        })}
      </section>
    </main>
  );
}
