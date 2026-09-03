import type { Metadata, Viewport } from "next";
import { AppShell } from "@/components/app-shell";
import type { AccountIdentity } from "@/components/account-menu";
import { PwaRegistrar } from "@/components/pwa-registrar";
import { getSession } from "@/lib/auth";
import { isMockMode } from "@/lib/environment";
import { DemoModeProvider } from "@/components/mode-provider";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000"),
  title: { default: "CreatorOS — Foundry Management", template: "%s · CreatorOS" },
  description:
    "Foundry Management's operating system for creator acquisition, operations, performance, and economics.",
  openGraph: {
    title: "CreatorOS — Foundry Management",
    description: "The operating system for creator acquisition, operations, and economics.",
    type: "website",
    images: [{ url: "/opengraph-image", width: 1200, height: 630, alt: "CreatorOS" }],
  },
  twitter: { card: "summary_large_image", images: ["/opengraph-image"] },
};

export const viewport: Viewport = { themeColor: "#1c1d1b", colorScheme: "light" };

function initialsFor(email: string): string {
  const local = email.split("@")[0] ?? email;
  const parts = local.split(/[._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? `${parts[0]?.[0]}${parts[1]?.[0]}` : local.slice(0, 2);
  return letters.toUpperCase();
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Resolved in the layout so every authenticated page renders the real signed-in
  // identity. This intentionally makes the shell dynamic: a per-tenant console
  // cannot be statically prerendered and still show whose session it is.
  // Authoritative: comes from the environment contract, which refuses mock mode
  // in any deployed environment.
  const demo = isMockMode();
  const session = await getSession().catch(() => null);
  const identity: AccountIdentity | null = session
    ? {
        email: session.email,
        role: session.role,
        initials: initialsFor(session.email),
        organizationId: session.organizationId,
        mock: session.userId === "demo-super-admin",
      }
    : null;
  return (
    <html lang="en">
      <body>
        <PwaRegistrar />
        <DemoModeProvider demo={demo}>
          <AppShell identity={identity}>{children}</AppShell>
        </DemoModeProvider>
      </body>
    </html>
  );
}
