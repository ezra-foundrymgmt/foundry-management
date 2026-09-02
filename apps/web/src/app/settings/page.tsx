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
  { name: "Integrations", desc: "Secure provider configuration and environments", icon: Plug },
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
        {sections.map((item) => (
          <article
            className="card card-pad"
            key={item.name}
            style={{ display: "flex", gap: 13, alignItems: "flex-start" }}
          >
            <span className="icon-button">
              <item.icon size={16} />
            </span>
            <div>
              <h3>{item.name}</h3>
              <p className="subtitle" style={{ lineHeight: 1.5 }}>
                {item.desc}
              </p>
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}
