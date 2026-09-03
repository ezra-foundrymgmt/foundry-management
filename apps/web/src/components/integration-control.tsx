"use client";

import { useState } from "react";
import { StatusBadge } from "@/components/status-badge";

/** What each Notion refusal means to the admin reading it. */
const NOTION_MESSAGES: Record<string, string> = {
  NOTION_PAGE_NOT_SHARED:
    "Notion cannot see that page. Share it with the CreatorOS integration, then try again.",
  NOTION_PAGE_ARCHIVED: "That page is archived. Restore it or choose another.",
  NOTION_TOKEN_UNAVAILABLE: "The Notion connection needs reauthorization.",
  INVALID_NOTION_PARENT_PAGE: "Use a valid Notion page ID.",
};

export function IntegrationControl({
  provider,
  status,
  live,
  parentPageTitle = null,
}: {
  provider: "slack" | "notion";
  status: string;
  live: boolean;
  /** The configured Creator Hub root, or null when nothing is configured. */
  parentPageTitle?: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [parentPageId, setParentPageId] = useState("");
  const connected = status === "CONNECTED" || status === "DEGRADED";

  async function checkHealth() {
    setBusy(true);
    setMessage("");
    const response = await fetch(`/api/integrations/${provider}/health`, { method: "POST" });
    const data = (await response.json()) as { status?: string; error?: string };
    setMessage(data.status ?? data.error ?? "Health check complete");
    setBusy(false);
    if (response.ok) window.location.reload();
  }

  async function disconnect() {
    if (
      !window.confirm(
        `Disconnect ${provider === "slack" ? "Slack" : "Notion"} from CreatorOS? Existing projected resources will remain in the provider.`,
      )
    )
      return;
    setBusy(true);
    const response = await fetch(`/api/integrations/${provider}`, { method: "DELETE" });
    setMessage(response.ok ? "Disconnected" : "Disconnect failed");
    setBusy(false);
    if (response.ok) window.location.reload();
  }

  async function configureNotion(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const response = await fetch("/api/integrations/notion/configuration", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentPageId }),
    });
    const data = (await response.json()) as { error?: string; parentPageTitle?: string };
    // The reason matters here: "not shared with the integration" and "no such
    // page" need different actions from the admin, and Notion answers both 404.
    setMessage(
      response.ok
        ? `Creator Hub root set to ${data.parentPageTitle ?? "the selected page"}`
        : ((data.error && NOTION_MESSAGES[data.error]) ??
            "That page could not be verified. Nothing changed."),
    );
    setBusy(false);
    if (response.ok) window.location.reload();
  }

  if (!live)
    return (
      <p className="integration-note">
        Preview mode uses deterministic mock resources. No external account is changed.
      </p>
    );
  if (!connected)
    return (
      <a className="button bronze" href={`/api/integrations/${provider}/install`}>
        Connect {provider === "slack" ? "Slack workspace" : "Notion workspace"}
      </a>
    );
  return (
    <div className="integration-actions">
      <button className="button" type="button" disabled={busy} onClick={() => void checkHealth()}>
        Test connection
      </button>
      <button
        className="button danger"
        type="button"
        disabled={busy}
        onClick={() => void disconnect()}
      >
        Disconnect
      </button>
      {provider === "notion" ? (
        <form className="integration-config" onSubmit={(event) => void configureNotion(event)}>
          <p style={{ fontSize: 11, margin: "0 0 6px" }}>
            <strong>Creator Hub root:</strong>{" "}
            {parentPageTitle ? parentPageTitle : <StatusBadge value="NOT_CONFIGURED" />}
          </p>
          <label htmlFor="notion-parent">
            {parentPageTitle ? "Change root page ID" : "Shared parent page ID"}
          </label>
          <div>
            <input
              id="notion-parent"
              className="input"
              value={parentPageId}
              onChange={(event) => setParentPageId(event.target.value)}
              placeholder="Paste the page ID"
              required
            />
            <button className="button primary" type="submit" disabled={busy}>
              Save
            </button>
          </div>
        </form>
      ) : null}
      {message ? (
        <p className="integration-note" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
