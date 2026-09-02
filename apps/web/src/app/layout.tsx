import type { Metadata, Viewport } from "next";
import { AppShell } from "@/components/app-shell";
import { PwaRegistrar } from "@/components/pwa-registrar";
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

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <PwaRegistrar />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
