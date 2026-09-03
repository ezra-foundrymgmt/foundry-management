"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  BarChart3,
  Bell,
  BookOpenCheck,
  BriefcaseBusiness,
  ClipboardCheck,
  Command,
  FlaskConical,
  Home,
  ListChecks,
  Plug,
  Search,
  Settings,
  ShieldAlert,
  Target,
  Users,
  Workflow,
} from "lucide-react";
import { creators, prospects, tasks } from "@creatoros/domain";
import { AccountMenu, type AccountIdentity } from "./account-menu";
import { WebMcpTools } from "./webmcp-tools";

const nav = [
  { label: "Command Center", href: "/", icon: Home },
  { section: "Relationships" },
  { label: "Prospects", href: "/crm/prospects", icon: Target },
  { label: "Applications", href: "/crm/applications", icon: ClipboardCheck },
  { label: "Creators", href: "/creators", icon: Users },
  { section: "Operations" },
  { label: "Workflows", href: "/workflows", icon: Workflow },
  { label: "Tasks", href: "/tasks", icon: ListChecks },
  { label: "Content", href: "/content", icon: BookOpenCheck },
  { label: "Experiments", href: "/experiments", icon: FlaskConical },
  { section: "Intelligence" },
  { label: "Reports", href: "/reports", icon: BarChart3 },
  { label: "Economics", href: "/economics", icon: BriefcaseBusiness },
  { label: "Integrations", href: "/settings/integrations", icon: Plug },
  { label: "Incidents", href: "/incidents", icon: ShieldAlert },
  { label: "Audit", href: "/audit", icon: Activity },
  { label: "Settings", href: "/settings", icon: Settings },
] as const;

const demoSearchable = [
  ...creators.map((item) => ({
    label: item.stageName,
    sub: `Creator · ${item.creatorNumber}`,
    href: `/creators/${item.id}`,
  })),
  ...prospects.map((item) => ({
    label: item.stageName,
    sub: `Prospect · ${item.prospectNumber}`,
    href: "/crm/prospects",
  })),
  ...tasks.map((item) => ({ label: item.title, sub: `Task · ${item.department}`, href: "/tasks" })),
];

export function AppShell({
  children,
  identity = null,
}: {
  children: React.ReactNode;
  identity?: AccountIdentity | null;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [commandOpen, setCommandOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [liveResults, setLiveResults] = useState<typeof demoSearchable>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const demo = process.env["NEXT_PUBLIC_CREATOROS_DEMO_MODE"] !== "false";
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
      }
      if (event.key === "Escape") setCommandOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  useEffect(() => {
    if (commandOpen) inputRef.current?.focus();
  }, [commandOpen]);
  useEffect(() => {
    if (demo || query.trim().length < 2) {
      setLiveResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then((response) => response.json())
        .then((body: { data?: Array<{ type: string; id: string; label: string }> }) =>
          setLiveResults(
            (body.data ?? []).map((item) => ({
              label: item.label,
              sub: item.type,
              href:
                item.type === "creator"
                  ? `/creators/${item.id}`
                  : item.type === "prospect"
                    ? "/crm/prospects"
                    : "/tasks",
            })),
          ),
        )
        .catch(() => undefined);
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [demo, query]);
  const results = useMemo(
    () =>
      (demo ? demoSearchable : liveResults)
        .filter((item) => `${item.label} ${item.sub}`.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 8),
    [demo, liveResults, query],
  );
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
  const navigate = (href: string) => {
    setCommandOpen(false);
    setQuery("");
    router.push(href);
  };

  if (pathname === "/login") return children;
  return (
    <div className="app-shell">
      <WebMcpTools />
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand">
          <div className="brand-mark">F</div>
          <div>
            <strong>CREATOROS</strong>
            <span>Foundry Management</span>
          </div>
        </div>
        <nav className="nav">
          {nav.map((item, index) =>
            "section" in item ? (
              <div className="nav-label" key={`${item.section}-${index}`}>
                {item.section}
              </div>
            ) : (
              <a
                className={`nav-link ${isActive(item.href) ? "active" : ""}`}
                href={item.href}
                key={item.href}
              >
                <item.icon />
                <span>{item.label}</span>
              </a>
            ),
          )}
        </nav>
      </aside>
      <div className="main-column">
        <div className="topbar">
          <button type="button" className="search-button" onClick={() => setCommandOpen(true)}>
            <Search size={15} />
            <span>Search creators, tasks, reports…</span>
            <kbd>⌘ K</kbd>
          </button>
          <div className="top-actions">
            <a className="icon-button" aria-label="Notifications and incidents" href="/incidents">
              <Bell size={16} />
            </a>
            <AccountMenu identity={identity} />
          </div>
        </div>
        {children}
      </div>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {nav
          .filter(
            (item) =>
              "href" in item &&
              ["/", "/crm/prospects", "/creators", "/tasks", "/reports"].includes(item.href),
          )
          .map((item) =>
            "href" in item ? (
              <a className={isActive(item.href) ? "active" : ""} href={item.href} key={item.href}>
                <item.icon />
                <span>{item.label.split(" ")[0]}</span>
              </a>
            ) : null,
          )}
      </nav>
      {commandOpen ? (
        <div
          className="command-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setCommandOpen(false);
          }}
        >
          <div className="command-box" role="dialog" aria-modal="true" aria-label="Global search">
            <div style={{ display: "flex", alignItems: "center", paddingLeft: 16 }}>
              <Command size={17} />
              <input
                ref={inputRef}
                className="input command-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search CreatorOS…"
                aria-label="Search CreatorOS"
              />
            </div>
            <div className="command-results">
              {results.length ? (
                results.map((item) => (
                  <button
                    type="button"
                    className="command-result"
                    key={`${item.sub}-${item.label}`}
                    onClick={() => navigate(item.href)}
                  >
                    <strong>{item.label}</strong>
                    <span>{item.sub}</span>
                  </button>
                ))
              ) : (
                <div className="empty-state">
                  <strong>No results</strong>Try a creator, task, or prospect name.
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
