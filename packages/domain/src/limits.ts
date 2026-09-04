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
