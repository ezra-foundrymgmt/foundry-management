import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
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

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
