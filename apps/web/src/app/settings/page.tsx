import Link from "next/link";
import {
  Activity,
  Building2,
  CalendarClock,
  HeartPulse,
  KeyRound,
  ListChecks,
  Network,
  Plug,
  Scale,
  Shield,
  Users,
} from "lucide-react";
import { DemoStrip, PageHeader } from "@/components/page-header";

/**
 * A roadmap of Foundry's configuration surface, not all of it built yet.
 * "Integrations" is the one section that already exists elsewhere
 * (/settings/integrations) — everything else here is a real destination this
 * page does not have. Only sections with an href are ever links; the rest stay
 * static so nothing here promises a page that isn't there.
 */
const sections = [
  {
    name: "Organization",
    desc: "Foundry identity, locale, and operating defaults",
    icon: Building2,
  },
  { name: "Users & roles", desc: "Membership, least privilege, and role permissions", icon: Users },
  {
    name: "Workflow settings",
    desc: "Prerequisites, retries, and manual intervention",
    icon: ListChecks,
  },
  { name: "Creator health", desc: "Weights, thresholds, and critical overrides", icon: HeartPulse },
  { name: "Fit score", desc: "Qualification weights and disqualifying flags", icon: Scale },
  {
    name: "Content inventory",
    desc: "Target, warning, and critical buffer levels",
    icon: Activity,
  },
  {
    name: "Integrations",
    desc: "Secure provider configuration and environments",
    icon: Plug,
    href: "/settings/integrations",
  },
  { name: "Reporting cadence", desc: "Daily, weekly, and monthly schedules", icon: CalendarClock },
  { name: "Naming conventions", desc: "Slack, Notion, and file resource patterns", icon: Network },
  { name: "Security", desc: "Sessions, policies, and access review", icon: Shield },
  { name: "Audit", desc: "Retention and export controls", icon: KeyRound },
];
export default function SettingsPage() {
  return (
    <main className="page">
      <DemoStrip />
      <PageHeader
        eyebrow="Foundry configuration"
        title="Settings"
        subtitle="Operational thresholds are configuration—not hardcoded business law."
      />
      <div className="grid detail-grid">
        {sections.map((item) => {
          const content = (
            <>
              <span className="icon-button">
                <item.icon size={16} />
              </span>
              <div>
                <h3>{item.name}</h3>
                <p className="subtitle" style={{ lineHeight: 1.5 }}>
                  {item.desc}
                </p>
                {/* Says so on the card rather than leaving an operator to
                    discover it by clicking. Only Integrations is built; the
                    rest looked identical to it and behaved like dead cards. */}
                {item.href ? null : (
                  <span
                    className="eyebrow"
                    style={{ display: "inline-block", marginTop: 6, opacity: 0.7 }}
                  >
                    NOT BUILT YET
                  </span>
                )}
              </div>
            </>
          );
          return item.href ? (
            <Link
              href={item.href}
              className="card card-pad"
              key={item.name}
              style={{ display: "flex", gap: 13, alignItems: "flex-start" }}
            >
              {content}
            </Link>
          ) : (
            <article
              className="card card-pad"
              key={item.name}
              style={{ display: "flex", gap: 13, alignItems: "flex-start" }}
            >
              {content}
            </article>
          );
        })}
      </div>
    </main>
  );
}
