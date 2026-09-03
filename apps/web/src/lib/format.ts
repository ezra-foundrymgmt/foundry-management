/**
 * CreatorOS never renders an absent measurement as a number. Unknown stays
 * visibly unknown so an operator can tell "no data imported" apart from a real
 * zero, which is a materially different business fact.
 */
export const UNKNOWN_DISPLAY = "—";

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const count = new Intl.NumberFormat("en-US");

export function formatMoney(value: number | null | undefined): string {
  return value === null || value === undefined ? UNKNOWN_DISPLAY : money.format(value);
}

export function formatCount(value: number | null | undefined): string {
  return value === null || value === undefined ? UNKNOWN_DISPLAY : count.format(value);
}

export function formatTrend(value: number | null | undefined): string {
  if (value === null || value === undefined) return UNKNOWN_DISPLAY;
  return `${value > 0 ? "+" : ""}${value}%`;
}

export function trendClassName(value: number | null | undefined): string {
  if (value === null || value === undefined) return "trend-unknown";
  return value >= 0 ? "trend-up" : "trend-down";
}

export function formatScore(value: number | null | undefined): string {
  return value === null || value === undefined ? UNKNOWN_DISPLAY : String(value);
}
