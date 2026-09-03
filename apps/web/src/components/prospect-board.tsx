"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Filter, Search } from "lucide-react";
import { PIPELINE_STAGES } from "@creatoros/domain";
import { ConvertProspectButton } from "@/components/convert-prospect-button";
import { StatusBadge } from "@/components/status-badge";
import { formatScore } from "@/lib/format";

export interface ProspectCard {
  id: string;
  stageName: string;
  niche: string;
  followerCountEstimate: number | null;
  fitScore: number | null;
  fitTier: string;
  pipelineStage: string;
  owner: string | null;
  nextFollowupAt: string | null;
  updatedAt: string;
}

export function ProspectBoard({
  prospects,
  readOnly,
  canConvertToCreator,
}: {
  prospects: ProspectCard[];
  readOnly: boolean;
  canConvertToCreator: boolean;
}) {
  const [query, setQuery] = useState("");
  const [onlyFollowUpDue, setOnlyFollowUpDue] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const router = useRouter();

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return prospects.filter((prospect) => {
      if (
        needle &&
        !`${prospect.stageName} ${prospect.niche} ${prospect.owner ?? ""}`
          .toLowerCase()
          .includes(needle)
      )
        return false;
      if (onlyFollowUpDue) {
        if (!prospect.nextFollowupAt) return false;
        if (new Date(prospect.nextFollowupAt).getTime() > Date.now()) return false;
      }
      return true;
    });
  }, [prospects, query, onlyFollowUpDue]);

  async function patch(prospect: ProspectCard, body: Record<string, unknown>) {
    setBusyId(prospect.id);
    setError(null);
    try {
      const response = await fetch(`/api/prospects/${prospect.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        // updatedAt is the optimistic-concurrency token this card was loaded
        // with. A 409 means someone else changed the prospect first.
        body: JSON.stringify({ ...body, updatedAt: prospect.updatedAt }),
      });
      if (!response.ok) {
        if (response.status === 409) {
          throw new Error("Someone else updated this prospect first. Refresh and try again.");
        }
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Request failed (${response.status})`);
      }
      // Re-fetch the server component so the board reflects committed state
      // rather than an optimistic guess.
      startTransition(() => router.refresh());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Update failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="table-toolbar card" style={{ marginBottom: 14 }}>
        <Search size={15} />
        <input
          className="input toolbar-search"
          placeholder="Search prospects…"
          aria-label="Search prospects"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className={`button${onlyFollowUpDue ? " primary" : ""}`}
          aria-pressed={onlyFollowUpDue}
          onClick={() => setOnlyFollowUpDue((value) => !value)}
        >
          <Filter size={13} /> Follow-up due
        </button>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-soft)" }}>
          {filtered.length} of {prospects.length}
        </span>
      </div>

      {error ? (
        <p className="card card-pad" role="alert" style={{ marginBottom: 14, color: "var(--red)" }}>
          {error}
        </p>
      ) : null}

      <section className="grid kanban" aria-label="Prospect pipeline">
        {/* Every canonical stage, not a hardcoded subset -- a prospect in a
            stage left off that subset used to be filtered out of the board
            entirely, with no column to show it was missing. */}
        {PIPELINE_STAGES.map((stage) => {
          const items = filtered.filter((prospect) => prospect.pipelineStage === stage);
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
                        label={`${formatScore(prospect.fitScore)} · ${prospect.fitTier}`}
                      />
                      <span style={{ fontSize: 10, color: "var(--ink-soft)" }}>
                        {prospect.owner ?? "Unassigned"}
                      </span>
                    </div>

                    {prospect.nextFollowupAt ? (
                      <p style={{ fontSize: 10, color: "var(--ink-soft)", marginTop: 6 }}>
                        Follow up {new Date(prospect.nextFollowupAt).toLocaleDateString()}
                      </p>
                    ) : null}

                    {readOnly ? null : (
                      <div className="kanban-actions">
                        <label className="visually-hidden" htmlFor={`stage-${prospect.id}`}>
                          Pipeline stage for {prospect.stageName}
                        </label>
                        <select
                          id={`stage-${prospect.id}`}
                          className="input"
                          value={prospect.pipelineStage}
                          disabled={busyId === prospect.id}
                          onChange={(event) =>
                            void patch(prospect, { pipelineStage: event.target.value })
                          }
                        >
                          {PIPELINE_STAGES.map((option) => (
                            <option key={option} value={option}>
                              {option.replaceAll("_", " ")}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="button"
                          disabled={busyId === prospect.id}
                          onClick={() => void patch(prospect, { archived: true })}
                        >
                          Archive
                        </button>
                      </div>
                    )}

                    {/* The server requires creator.create for this action, which
                        only super_admin holds -- showing the button to every role
                        that can view this board (growth, creator_success, ...)
                        meant clicking it as anyone else always failed server-side. */}
                    {prospect.pipelineStage === "SIGNED" && canConvertToCreator ? (
                      <div style={{ marginTop: 12 }}>
                        <ConvertProspectButton prospectId={prospect.id} />
                      </div>
                    ) : null}
                  </article>
                ))
              ) : (
                <div className="empty-state" style={{ padding: 24 }}>
                  <strong>No prospects</strong>
                  {query || onlyFollowUpDue
                    ? "None match the current filter."
                    : "Move qualified relationships here."}
                </div>
              )}
            </div>
          );
        })}
      </section>
    </>
  );
}
