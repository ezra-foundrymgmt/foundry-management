/**
 * Input bounds shared by the forms that collect a value and the schemas that
 * accept it.
 *
 * The follower estimate had the cap written once in the server schema and
 * nowhere in the form, so an operator could type past it and get back the
 * literal string `INVALID_INPUT` — a code that names no field and suggests no
 * fix. A bound enforced on only one side of the wire is a bound the user finds
 * out about by failing.
 */

/** Upper bound on a prospect's follower estimate. */
export const MAX_FOLLOWER_ESTIMATE = 1_000_000_000;

/**
 * Platforms a social post may be imported from.
 *
 * Closed, and uppercase to match every other machine-compared platform value
 * in the schema (`creator_revenue_daily.platform`, `social_accounts.provider`,
 * `integration_connections.provider`).
 *
 * This is closed because `platform` is part of the social natural key
 * (migration 202609040015). As free text, "Instagram", "instagram" and "IG"
 * are three distinct keys for one post, so the index that exists to prevent
 * duplicates would be defeated by capitalisation — and both report readers sum
 * across rows without dedupe.
 */
export const SOCIAL_PLATFORMS = ["INSTAGRAM", "TIKTOK", "X", "YOUTUBE", "REDDIT"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

/**
 * Upper bound on any single social engagement metric.
 *
 * These columns are `bigint`, so the database would accept a number far beyond
 * anything real. `freezeBaseline` sums them into a permanent artifact, so one
 * fat-fingered value is frozen and then inherited by every future comparison.
 * A hundred billion is orders of magnitude above the largest real post and
 * still nowhere near the column's limit.
 */
export const MAX_SOCIAL_METRIC = 100_000_000_000;

/**
 * Digits only, no leading zeros, never above the cap.
 *
 * Returns "" for input with no digits at all, because the estimate is optional
 * and an operator who does not know the number must be able to leave it
 * unknown rather than have it become a zero that reads as a real measurement.
 */
export function clampFollowerEstimate(value: string): string {
  const digits = value.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  if (digits === "") return "";
  return String(Math.min(Number.parseInt(digits, 10), MAX_FOLLOWER_ESTIMATE));
}
