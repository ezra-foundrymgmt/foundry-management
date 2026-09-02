import { Bot, Database, FolderOpen, MessageSquare, Network, PanelsTopLeft } from "lucide-react";
import { DemoStrip, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
const integrations = [
  {
    name: "Slack",
    icon: MessageSquare,
    category: "Communication",
    status: "MOCK",
    detail: "Channels and messages persist as mock provisioning resources.",
  },
  {
    name: "Notion",
    icon: PanelsTopLeft,
    category: "Knowledge",
    status: "MOCK",
    detail: "Creator Hub and internal resource adapters are testable.",
  },
  {
    name: "Google",
    icon: FolderOpen,
    category: "Files & calendar",
    status: "NOT_CONFIGURED",
    detail: "Typed file structure and calendar interfaces are ready.",
  },
  {
    name: "Creator Revenue",
    icon: Database,
    category: "Revenue",
    status: "MOCK",
    detail: "Deterministic daily revenue powers demo diagnostics.",
  },
  {
    name: "Claude",
    icon: Bot,
    category: "Intelligence",
    status: "NOT_CONFIGURED",
    detail: "Rules provider remains the source of V1 diagnosis.",
  },
  {
    name: "OpenAI",
    icon: Network,
    category: "Intelligence",
    status: "NOT_CONFIGURED",
    detail: "Optional enrichment provider; no API key required.",
  },
];
export default function IntegrationsPage() {
  return (
    <main className="page">
      <DemoStrip />
      <PageHeader
        eyebrow="Provider registry"
        title="Integrations"
        subtitle="CreatorOS owns operational state; external systems are replaceable, least-privilege projections and data sources."
      />
      <div className="grid detail-grid">
        {integrations.map((item) => (
          <article className="card card-pad" key={item.name}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <span className="icon-button">
                  <item.icon size={16} />
                </span>
                <div>
                  <strong>{item.name}</strong>
                  <div style={{ fontSize: 10, color: "var(--ink-soft)", marginTop: 2 }}>
                    {item.category}
                  </div>
                </div>
              </div>
              <StatusBadge value={item.status} />
            </div>
            <p className="subtitle" style={{ lineHeight: 1.6, marginTop: 16, minHeight: 34 }}>
              {item.detail}
            </p>
            <button
              className="button"
              style={{ marginTop: 15 }}
              disabled
              title={
                item.status === "MOCK"
                  ? "Mock resources are visible in workflow runs"
                  : "Provider credentials are not configured"
              }
            >
              {item.status === "MOCK" ? "View mock resources" : "Configuration required"}
            </button>
          </article>
        ))}
      </div>
    </main>
  );
}
