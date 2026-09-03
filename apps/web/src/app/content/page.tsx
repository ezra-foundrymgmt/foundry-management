import { AccessDenied } from "@/components/access-denied";
import { DemoStrip, PageHeader } from "@/components/page-header";
import { LiveEmpty } from "@/components/live-empty";
import { StatusBadge } from "@/components/status-badge";
import { formatCount, UNKNOWN_DISPLAY } from "@/lib/format";
import { isMockMode } from "@/lib/environment";
import { getLiveContentAssets, type LiveContentRow } from "@/lib/live-data";
import { authorizePage } from "@/lib/page-access";

/** Demo rows, shaped as live rows so there is one render path. */
const DEMO_CONTENT: LiveContentRow[] = [
  {
    id: "demo-asset-1",
    title: "Relationship POV variants",
    creatorName: "Madison Carter",
    assetType: "VIDEO",
    platform: "Instagram",
    approvalStatus: "APPROVED",
    inventoryCategory: "SOCIAL",
    usedCount: 2,
  },
  {
    id: "demo-asset-2",
    title: "Fall morning routine",
    creatorName: "Ava Monroe",
    assetType: "VIDEO",
    platform: "TikTok",
    approvalStatus: "REVIEW",
    inventoryCategory: "SOCIAL",
    usedCount: 0,
  },
];

export default async function ContentPage() {
  const access = await authorizePage("creator.read");
  if (!access.allowed)
    return <AccessDenied title="Content" permission="creator.read" reason={access.reason} />;

  const mock = isMockMode();
  const assets = mock ? DEMO_CONTENT : await getLiveContentAssets();
  const unused = assets.filter((asset) => asset.usedCount === 0);

  return (
    <main className="page">
      <DemoStrip />
      <PageHeader
        eyebrow="Content operations"
        title="Content inventory"
        subtitle="What exists, what is approved, and what has already been used — the buffer that keeps a creator publishing."
        actions={
          <span style={{ fontSize: 11, color: "var(--ink-soft)" }}>
            {unused.length} unused of {assets.length}
          </span>
        }
      />

      {assets.length === 0 ? (
        <LiveEmpty
          title="No content assets recorded"
          hint="Assets appear here once they are captured and registered against a creator."
        />
      ) : (
        <section className="card">
          <div className="section-head">
            <h2>Inventory</h2>
            <span className="subtitle">{assets.length} assets</span>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Creator</th>
                  <th>Type</th>
                  <th>Platform</th>
                  <th>Category</th>
                  <th>Used</th>
                  <th>Approval</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((asset) => (
                  <tr key={asset.id}>
                    <td>
                      <strong>{asset.title ?? "Untitled asset"}</strong>
                    </td>
                    <td>{asset.creatorName}</td>
                    <td>{asset.assetType ?? "Unclassified"}</td>
                    <td>{asset.platform ?? "Unassigned"}</td>
                    <td>{asset.inventoryCategory ?? "Uncategorised"}</td>
                    <td>{formatCount(asset.usedCount)}</td>
                    <td>
                      {/* null means no approval workflow has recorded a status
                          for this asset -- not the same as "awaiting review".
                          Fabricating PENDING claimed a specific state nobody
                          actually observed. */}
                      {asset.approvalStatus === null ? (
                        <span style={{ color: "var(--ink-soft)" }}>{UNKNOWN_DISPLAY}</span>
                      ) : (
                        <StatusBadge value={asset.approvalStatus} />
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
