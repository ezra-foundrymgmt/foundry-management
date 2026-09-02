"use client";

import { useState } from "react";

export function IntegrationControl({
  provider,
  status,
  live,
  needsConfiguration = false,
}: {
  provider: "slack" | "notion";
  status: string;
  live: boolean;
  needsConfiguration?: boolean;
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
    setMessage(response.ok ? "Parent page saved" : "Use a valid shared Notion page ID");
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
      {provider === "notion" && needsConfiguration ? (
        <form className="integration-config" onSubmit={(event) => void configureNotion(event)}>
          <label htmlFor="notion-parent">Shared parent page ID</label>
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
