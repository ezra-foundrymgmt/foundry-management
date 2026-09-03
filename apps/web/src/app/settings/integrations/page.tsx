import { AccessDenied } from "@/components/access-denied";
import { authorizePage } from "@/lib/page-access";
import {
  Braces,
  CheckCircle2,
  Database,
  ExternalLink,
  MessageSquare,
  PanelsTopLeft,
  ShieldCheck,
} from "lucide-react";
import { DemoStrip, PageHeader } from "@/components/page-header";
import { IntegrationControl } from "@/components/integration-control";
import { SlackIdentityManager } from "@/components/slack-identity-manager";
import { StatusBadge } from "@/components/status-badge";
import { isMockMode } from "@/lib/environment";
import { listIntegrationConnections } from "@/lib/integration-registry";
import { listSlackIdentities } from "@/lib/slack-identities";
import { hasPermission } from "@creatoros/domain";

interface ConnectionRecord {
  provider: string;
  status: string;
  environment: string;
  external_workspace_name: string | null;
  scopes: string[];
  configuration_json: Record<string, unknown>;
  last_health_check_at: string | null;
  last_error: string | null;
  needs_reauthorization: boolean;
}

export default async function IntegrationSettingsPage() {
  // This page reads tenant integration records through the service-role client,
  // which bypasses RLS, so the role check has to happen here — being signed in
  // is not enough to see which providers a tenant has connected.
  const access = await authorizePage("integration.read");
  if (!access.allowed)
    return (
      <AccessDenied title="Integrations" permission="integration.read" reason={access.reason} />
    );
  const mock = isMockMode();
  const records = mock
    ? []
    : ((await listIntegrationConnections(access.session.organizationId)) as ConnectionRecord[]);
  // Slack identity administration is a separate authority from reading which
  // providers are connected: linking an account grants it that user's role in
  // the Foundry agent.
  const canManageIdentities = hasPermission(access.session.role, "user.manage");
  const identities =
    canManageIdentities && !mock ? await listSlackIdentities(access.session.organizationId) : [];
  const find = (provider: string) => records.find((item) => item.provider === provider);
  const slack = find("SLACK");
  const notion = find("NOTION");
  return (
    <main className="page">
      <DemoStrip />
      <PageHeader
        eyebrow="Live provider registry"
        title="Integrations"
        subtitle="CreatorOS owns operational truth. Slack and Notion receive least-privilege projections through auditable, retry-safe adapters."
      />

      <section className="integration-summary card card-pad">
        <div>
          <span className="eyebrow">Environment</span>
          <strong>{mock ? "Safe preview" : "Live infrastructure"}</strong>
          <p>
            {mock
              ? "External calls are disabled while you navigate the product."
              : "OAuth tokens are encrypted at rest and never returned to the browser."}
          </p>
        </div>
        <div className="integration-boundary">
          <Database size={16} /> CreatorOS <span>→</span> <Braces size={16} /> Adapter{" "}
          <span>→</span> <ExternalLink size={16} /> Provider
        </div>
      </section>

      <div className="grid integration-grid">
        <ProviderCard
          provider="slack"
          name="Slack"
          icon={MessageSquare}
          status={mock ? "MOCK" : (slack?.status ?? "NOT_CONFIGURED")}
          workspace={slack?.external_workspace_name ?? null}
          detail="Creates private creator and internal channels, invites approved members, sets topics, and posts workflow notifications."
          scopes={slack?.scopes ?? ["channels", "private channels", "messages", "users"]}
          health={slack?.last_health_check_at ?? null}
          error={slack?.last_error ?? null}
          live={!mock}
        />
        <ProviderCard
          provider="notion"
          name="Notion"
          icon={PanelsTopLeft}
          status={mock ? "MOCK" : (notion?.status ?? "NOT_CONFIGURED")}
          workspace={notion?.external_workspace_name ?? null}
          detail="Projects approved creator hubs and internal operating pages. Sensitive operational truth remains in CreatorOS."
          scopes={notion?.scopes ?? ["read content", "insert content", "update content"]}
          health={notion?.last_health_check_at ?? null}
          error={notion?.last_error ?? null}
          live={!mock}
          needsConfiguration={!notion?.configuration_json?.["parentPageId"]}
        />
      </div>

      {canManageIdentities ? (
        <section className="card card-pad">
          <h2>Slack identities</h2>
          <p className="subtitle" style={{ marginTop: 6, lineHeight: 1.6 }}>
            The Foundry agent answers as the CreatorOS user a Slack account is linked to, with that
            user's role. An unlinked Slack account is denied — being in the workspace is not
            authorization. Slack confirms each account exists before the link is saved.
          </p>
          {mock ? (
            <p className="integration-note">
              Identity mapping is administered against live records. Preview mode has none.
            </p>
          ) : (
            <SlackIdentityManager identities={identities} />
          )}
        </section>
      ) : null}

      <section className="card card-pad integration-security">
        <ShieldCheck size={18} />
        <div>
          <h2>Security boundary</h2>
          <p>
            OAuth state is single-use and expires after ten minutes. Provider credentials are
            server-only, encrypted with AES-256-GCM, and separated from connection metadata.
            Disconnecting deletes the stored credential.
          </p>
        </div>
        <CheckCircle2 size={18} />
      </section>
    </main>
  );
}

function ProviderCard({
  provider,
  name,
  icon: Icon,
  status,
  workspace,
  detail,
  scopes,
  health,
  error,
  live,
  needsConfiguration = false,
}: {
  provider: "slack" | "notion";
  name: string;
  icon: typeof MessageSquare;
  status: string;
  workspace?: string | null;
  detail: string;
  scopes: string[];
  health?: string | null;
  error?: string | null;
  live: boolean;
  needsConfiguration?: boolean;
}) {
  return (
    <article className="card integration-card">
      <div className="integration-card-head">
        <span className="provider-icon">
          <Icon size={20} />
        </span>
        <div>
          <h2>{name}</h2>
          <p>{workspace ?? (live ? "No workspace connected" : "Deterministic preview adapter")}</p>
        </div>
        <StatusBadge value={status} />
      </div>
      <p className="integration-description">{detail}</p>
      <div className="scope-list">
        {scopes.map((scope) => (
          <span key={scope}>{scope}</span>
        ))}
      </div>
      <dl className="integration-meta">
        <div>
          <dt>Health checked</dt>
          <dd>{health ? new Date(health).toLocaleString() : "Not yet"}</dd>
        </div>
        <div>
          <dt>Last error</dt>
          <dd>{error ?? "None"}</dd>
        </div>
      </dl>
      <IntegrationControl
        provider={provider}
        status={status}
        live={live}
        needsConfiguration={needsConfiguration}
      />
    </article>
  );
}
