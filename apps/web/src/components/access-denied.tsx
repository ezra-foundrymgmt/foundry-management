import { ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import type { PageAccess } from "@/lib/page-access";

export function AccessDenied({
  title,
  permission,
  reason,
}: {
  title: string;
  permission: string;
  reason: Extract<PageAccess, { allowed: false }>["reason"];
}) {
  const signedOut = reason === "AUTHENTICATION_REQUIRED";
  return (
    <main className="page">
      <PageHeader
        eyebrow="Access"
        title={title}
        subtitle={
          signedOut
            ? "Sign in with your Foundry account to view this page."
            : "Your role does not grant access to this page."
        }
      />
      <section className="card" style={{ padding: 24 }}>
        <p style={{ display: "flex", alignItems: "center", gap: 8, margin: 0, fontWeight: 700 }}>
          <ShieldAlert size={16} /> {signedOut ? "Authentication required" : "Permission denied"}
        </p>
        <p style={{ marginTop: 8, fontSize: 12, color: "var(--ink-soft)" }}>
          This page requires the <code>{permission}</code> permission. Ask a Foundry super admin to
          adjust your role if you need it.
        </p>
        {signedOut ? (
          <a className="button primary" href="/login" style={{ marginTop: 12 }}>
            Go to sign in
          </a>
        ) : null}
      </section>
    </main>
  );
}
