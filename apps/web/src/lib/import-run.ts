import "server-only";
import { logEvent } from "@/lib/observability";

/**
 * The parts of an ingestion path that are genuinely common to both of them.
 *
 * Extracted from two real implementations — `importCreatorRevenue` and
 * `importCreatorSocialPosts` — rather than designed ahead of either. That
 * distinction is not academic here: `CreatorRevenueProvider` in
 * packages/integrations was written before any importer existed, is
 * structurally incompatible with the one that got built, and has never had a
 * caller. This module deliberately contains only what both concrete cases
 * already did the same way.
 *
 * What is NOT here, because the two cases differ irreducibly:
 *   - the natural key. Revenue keys on (creator_id, date, platform, source)
 *     because a revenue row is a per-day aggregate claim and two sources are
 *     two claims. Social keys on (creator_id, platform, external_post_id) and
 *     excludes source, because a post is one object in the world. An
 *     abstraction that forced either shape onto the other would be worse than
 *     the duplication it removed.
 *   - the row schema, the column mapping, and the audit action.
 */

/**
 * The subset of the Supabase client these helpers touch.
 *
 * Structural rather than imported: `createSupabaseAdminClient` returns a
 * deeply-generic client whose type is awkward to name, and narrowing to what is
 * actually used keeps this module testable with a plain fake.
 */
export interface ImportLedgerClient {
  from(table: string): {
    insert(payload: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>;
  };
}

/** What every import reports back to its caller. */
export interface ImportSummary {
  creatorId: string;
  rowsReceived: number;
  rowsWritten: number;
  source: string;
  dataConfidence: string;
}

/**
 * Refuses a payload that names the same natural key twice.
 *
 * Not a nicety. PostgreSQL raises 21000 — "ON CONFLICT DO UPDATE command
 * cannot affect row a second time" — when a single upsert statement touches
 * one row twice, so the whole import fails with an opaque 500 from the driver
 * rather than a message naming the duplicate. Catching it here turns that into
 * a typed 400 the operator can act on.
 *
 * Returns the offending key so the caller can name it, or null when the
 * payload is clean.
 */
export function findDuplicateKey(keys: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return null;
}

/**
 * Records one import in `data_import_runs`.
 *
 * Called AFTER the data write, so a run that appears in the ledger is one that
 * actually landed, and best-effort so bookkeeping can never fail an import
 * that already committed — the same reasoning the audit writes use.
 *
 * Two things this fixes relative to the first implementation, which wrote the
 * ledger inline:
 *
 *   - `provider` and `source` were inverted. Everywhere else in this schema
 *     `provider` names the external system (`social_accounts.provider`,
 *     `integration_connections.provider`) — but the revenue import wrote
 *     `provider: input.source` (OPERATOR_ENTRY) and `source: input.platform`
 *     (ONLYFANS). Anyone reading the ledger by column name read it backwards.
 *     BOTH importers now call this, so the ledger has one convention; rows
 *     written before this change still carry the inverted one.
 *   - supabase-js RESOLVES with `{ error }` rather than throwing, so the
 *     surrounding try/catch never fired and a failed ledger write was silently
 *     lost. The returned error is checked explicitly.
 */
export async function recordImportRun(
  client: ImportLedgerClient,
  run: {
    organizationId: string;
    creatorId: string;
    /** The external system the data describes, e.g. ONLYFANS, INSTAGRAM. */
    provider: string;
    /** How the data reached us, e.g. OPERATOR_ENTRY. */
    source: string;
    idempotencyKey: string;
    rowsReceived: number;
    rowsWritten: number;
    startedAt: string;
  },
): Promise<void> {
  try {
    const { error } = await client.from("data_import_runs").insert({
      organization_id: run.organizationId,
      creator_id: run.creatorId,
      provider: run.provider,
      source: run.source,
      status: "SUCCEEDED",
      idempotency_key: run.idempotencyKey,
      rows_received: run.rowsReceived,
      /**
       * An upsert does not tell us how many rows it inserted versus updated —
       * PostgREST returns every affected row either way — so claiming a split
       * would be inventing it. `rows_inserted` carries the honest total and
       * `rows_updated` stays 0 rather than fabricating a breakdown.
       */
      rows_inserted: run.rowsWritten,
      rows_updated: 0,
      rows_rejected: run.rowsReceived - run.rowsWritten,
      started_at: run.startedAt,
      completed_at: new Date().toISOString(),
    });
    if (error) throw new Error(error.message);
  } catch (cause) {
    logEvent("error", "import_run.ledger_failed", {
      creatorId: run.creatorId,
      provider: run.provider,
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
