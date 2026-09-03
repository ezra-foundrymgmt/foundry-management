"use client";

import { useState } from "react";
import { StatusBadge } from "@/components/status-badge";

export interface SlackIdentityView {
  userId: string;
  displayName: string | null;
  email: string;
  role: string;
  slackUserId: string | null;
  slackDisplayName: string | null;
  linked: boolean;
  lastVerifiedAt: string | null;
}

/** What each refusal means to the admin reading it. */
const MESSAGES: Record<string, string> = {
  SLACK_USER_NOT_FOUND: "Slack does not recognize that member ID in this workspace.",
  SLACK_USER_IN_DIFFERENT_WORKSPACE: "That Slack account belongs to a different workspace.",
  SLACK_WORKSPACE_NOT_CONNECTED: "Connect the Slack workspace before linking identities.",
  SLACK_TOKEN_UNAVAILABLE: "The Slack connection needs reauthorization.",
  USER_NOT_IN_ORGANIZATION: "That user is not an active member of this organization.",
  SLACK_IDENTITY_NOT_FOUND: "That user has no Slack link to remove.",
  PERMISSION_DENIED: "Linking Slack identities requires user administration.",
};

/**
 * Links Slack accounts to CreatorOS users.
 *
 * The Slack member ID is typed in deliberately rather than picked from a
 * directory of workspace members: the admin has to name the account they mean.
 * A picker invites linking whoever is at the top of the list, and this grant
 * hands the Foundry agent that person's role.
 */
export function SlackIdentityManager({ identities }: { identities: SlackIdentityView[] }) {
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");

  async function submit(userId: string, method: "POST" | "DELETE") {
    setBusyUserId(userId);
    setMessage("");
    const body =
      method === "POST"
        ? { userId, slackUserId: (drafts[userId] ?? "").trim().toUpperCase() }
        : { userId };
    const response = await fetch("/api/integrations/slack/identities", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await response.json()) as { error?: string };
    setBusyUserId(null);
    if (response.ok) {
      window.location.reload();
      return;
    }
    setMessage(
      (data.error && MESSAGES[data.error]) ?? "That link could not be saved. Nothing changed.",
    );
  }

  if (!identities.length)
    return (
      <p className="integration-note">
        No active organization members to link. Slack identities are read from live records.
      </p>
    );

  return (
    <div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>CreatorOS user</th>
              <th>Role</th>
              <th>Slack</th>
              <th>Status</th>
              <th>Last verified</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {identities.map((identity) => (
              <tr key={identity.userId}>
                <td>
                  <strong>{identity.displayName ?? identity.email}</strong>
                  <div style={{ fontSize: 10, color: "var(--ink-soft)" }}>{identity.email}</div>
                </td>
                <td>{identity.role}</td>
                <td>
                  {identity.linked ? (
                    <>
                      <div>{identity.slackDisplayName ?? "Unnamed Slack account"}</div>
                      <code style={{ fontSize: 10 }}>{identity.slackUserId}</code>
                    </>
                  ) : (
                    <>
                      <label className="visually-hidden" htmlFor={`slack-id-${identity.userId}`}>
                        Slack member ID for {identity.email}
                      </label>
                      <input
                        id={`slack-id-${identity.userId}`}
                        className="input"
                        placeholder="U01234567"
                        value={drafts[identity.userId] ?? ""}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [identity.userId]: event.target.value,
                          }))
                        }
                      />
                    </>
                  )}
                </td>
                <td>
                  <StatusBadge value={identity.linked ? "CONNECTED" : "NOT_LINKED"} />
                </td>
                <td>{identity.lastVerifiedAt?.slice(0, 10) ?? "—"}</td>
                <td>
                  {identity.linked ? (
                    <button
                      className="button danger"
                      type="button"
                      disabled={busyUserId === identity.userId}
                      onClick={() => void submit(identity.userId, "DELETE")}
                    >
                      Unlink
                    </button>
                  ) : (
                    <button
                      className="button"
                      type="button"
                      disabled={
                        busyUserId === identity.userId || !(drafts[identity.userId] ?? "").trim()
                      }
                      onClick={() => void submit(identity.userId, "POST")}
                    >
                      Link
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {message ? (
        <p className="integration-note" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
