/**
 * Pure input handling for the measurement import panel.
 *
 * Lives outside the component so it can be tested directly: the panel is a
 * .tsx client component and this project's tsconfig sets `jsx: preserve`, so a
 * .ts test importing it fails to transform. These are exactly the parts worth
 * pinning — a blank field becoming a zero, and a missing date wedging the form.
 */

/**
 * A blank field is not zero.
 *
 * `Number("")` is 0 and `parseInt("")` is NaN, so either careless conversion
 * turns "I did not read this metric" into a measurement of zero, which is then
 * summed into a report and frozen into a baseline.
 *
 * Anything that is not a finite number is also null rather than zero, for the
 * same reason: a typo is not a measurement.
 */
export function numberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** True when the operator typed something that is not a usable number. */
export function isUnparseableNumber(value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== "" && !Number.isFinite(Number(trimmed));
}

export interface ImportRowInput {
  /** date for revenue, externalPostId for social. */
  identity: string;
  publishedAt: string;
  values: Record<string, string>;
}

export type ImportRowProblem =
  | "NO_ROWS"
  | "ROW_WITHOUT_IDENTITY"
  | "MISSING_PUBLISHED_DATE"
  | "UNPARSEABLE_NUMBER";

/**
 * Checks a batch before any of it is turned into a request.
 *
 * The publish-date check is not cosmetic: the panel builds an instant as
 * `new Date(\`${publishedAt}T12:00:00Z\`)`, and with an empty date that is an
 * Invalid Date whose `.toISOString()` throws a RangeError. Thrown mid-submit it
 * escaped the whole handler, so `busy` was never cleared and the panel sat on
 * "Importing…" forever with no error and no way back short of a reload.
 *
 * The identity check exists because rows without one are filtered out before
 * sending: a row carrying real numbers but no id would vanish silently, and
 * the success message would count only the survivors.
 */
export function findImportProblem(
  rows: readonly ImportRowInput[],
  mode: "revenue" | "social",
): ImportRowProblem | null {
  const filled = rows.filter((row) => row.identity.trim() !== "");
  if (filled.length === 0) return "NO_ROWS";

  const abandoned = rows.some(
    (row) =>
      row.identity.trim() === "" && Object.values(row.values).some((value) => value.trim() !== ""),
  );
  if (abandoned) return "ROW_WITHOUT_IDENTITY";

  if (mode === "social" && filled.some((row) => row.publishedAt.trim() === ""))
    return "MISSING_PUBLISHED_DATE";

  const typo = filled.some((row) => Object.values(row.values).some(isUnparseableNumber));
  if (typo) return "UNPARSEABLE_NUMBER";

  return null;
}
