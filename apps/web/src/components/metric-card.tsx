import { ArrowDownRight, ArrowUpRight } from "lucide-react";

export function MetricCard({
  label,
  value,
  change,
  context,
}: {
  label: string;
  value: string;
  change?: number;
  context: string;
}) {
  return (
    <article className="card metric-card">
      <div className="metric-label">
        <span>{label}</span>
        <span>28D</span>
      </div>
      <div className="metric-value">{value}</div>
      <div className="metric-foot">
        {change === undefined ? null : change >= 0 ? (
          <ArrowUpRight size={13} className="trend-up" />
        ) : (
          <ArrowDownRight size={13} className="trend-down" />
        )}
        {change === undefined ? null : (
          <strong className={change >= 0 ? "trend-up" : "trend-down"}>
            {change > 0 ? "+" : ""}
            {change.toFixed(1)}%
          </strong>
        )}
        <span>{context}</span>
      </div>
    </article>
  );
}
