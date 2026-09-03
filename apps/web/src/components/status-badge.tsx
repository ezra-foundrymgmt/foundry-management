import clsx from "clsx";

const colors: Record<string, string> = {
  GREEN: "green",
  ACTIVE: "green",
  SUCCEEDED: "green",
  CONNECTED: "green",
  HEALTHY: "green",
  PRIORITY: "green",
  OPPORTUNITY: "green",
  DONE: "green",
  PUBLISHED: "green",
  WATCH: "yellow",
  ONBOARDING: "yellow",
  INCOMPLETE: "yellow",
  WAITING_EXTERNAL: "yellow",
  WAITING: "yellow",
  HIGH: "yellow",
  REVIEW: "yellow",
  IN_PROGRESS: "yellow",
  MOCK: "yellow",
  QUALIFIED: "yellow",
  BLOCKED: "red",
  AT_RISK: "red",
  CRITICAL: "red",
  FAILED: "red",
  DEGRADED: "red",
  ERROR: "red",
  OVERDUE: "red",
  WEAK: "red",
  READY: "blue",
  RUNNING: "blue",
  OPEN: "blue",
  CONFIGURED: "blue",
};

export function StatusBadge({ value, label }: { value: string; label?: string }) {
  return (
    <span className={clsx("badge", colors[value] ?? "neutral")}>
      {label ?? value.replaceAll("_", " ")}
    </span>
  );
}
