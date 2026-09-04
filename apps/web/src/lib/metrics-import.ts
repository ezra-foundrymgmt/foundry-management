import "server-only";
import { z } from "zod";
import { DATA_CONFIDENCES } from "@creatoros/domain";
import type { AppSession } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { appendAudit } from "@/lib/audit";
import { logEvent } from "@/lib/observability";
import { recordImportRun } from "@/lib/import-run";

/**
 * The write path for measured creator revenue.
 *
 * `creator_revenue_daily` has been read by four call sites since the first
 * migration -- the daily report, the creator roster, Creator 360 and the Slack
 * agent -- and written by nothing but `supabase/seed.sql`. Every figure the
 * operating system reports was therefore structurally absent, and the report
 * pipeline returned NO_METRICS_FOR_PERIOD forever.
 *
 * This is deliberately source-agnostic. `source` and `dataConfidence` are
 * required on every row, so a figure an operator typed from a platform
 * dashboard is a different claim from one a provider reported, and the
 * difference survives into the report that cites it. A future
 * `CreatorRevenueProvider` implementation becomes another caller of this same
 * function rather than a second, divergent write path.
 */
export const revenueRowSchema = z.object({
  // A calendar date in the creator's own reporting, not a timestamp: the
  // natural key is (creator_id, date, platform, source).
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  creatorPlatformReceipts: z.number().min(0).max(10_000_000).nullable().optional(),
  newSubscribers: z.number().int().min(0).max(10_000_000).nullable().optional(),
  firstBuyers: z.number().int().min(0).max(10_000_000).nullable().optional(),
  activeSubscribers: z.number().int().min(0).max(10_000_000).nullable().optional(),
  payingFans: z.number().int().min(0).max(10_000_000).nullable().optional(),
});

export const revenueImportSchema = z.object({
  platform: z.string().trim().min(1).max(40),
  /**
   * Where these figures came from. Part of the row's natural key, so two
   * sources reporting the same creator-day coexist as separate rows rather
   * than silently overwriting each other.
   */
  source: z.string().trim().min(1).max(60),
  dataConfidence: z.enum(DATA_CONFIDENCES),
  rows: z.array(revenueRowSchema).min(1).max(400),
});

/** A reason the caller is allowed to see. Routes return `message` verbatim. */
export class MetricsImportError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function databaseFailure(operation: string, error: { message: string }): MetricsImportError {
  logEvent("error", "metrics_import.database_failed", { operation, message: error.message });
  return new MetricsImportError("METRICS_IMPORT_DATABASE_FAILED", 500);
}

function admin() {
  const client = createSupabaseAdminClient();
  if (!client) throw new MetricsImportError("DATABASE_NOT_CONFIGURED", 503);
  return client;
}

/**
 * Imports daily revenue figures for one creator.
 *
 * Rows are upserted on the natural key so a re-import of a corrected day
 * replaces that day rather than duplicating it -- and so a nervous double
 * submit is harmless. Every run is recorded in `data_import_runs`, the table
 * the schema has always had for exactly this and which no code had ever
 * written, so an operator can see what was accepted and when.
 */
export async function importCreatorRevenue(
  session: AppSession,
  creatorId: string,
  input: z.infer<typeof revenueImportSchema>,
) {
  const client = admin();

  const creator = await client
    .from("creators")
    .select("id,stage_name")
    .eq("organization_id", session.organizationId)
    .eq("id", creatorId)
    .maybeSingle();
  if (creator.error) throw databaseFailure("creator-lookup", creator.error);
  if (!creator.data) throw new MetricsImportError("CREATOR_NOT_FOUND", 404);
  const found = creator.data as { stage_name: string };

  // One row per creator-day is what the natural key permits; a payload
  // repeating a date would make the upsert's own outcome order-dependent.
  const dates = new Set(input.rows.map((row) => row.date));
  if (dates.size !== input.rows.length)
    throw new MetricsImportError("DUPLICATE_DATES_IN_PAYLOAD", 400);

  const startedAt = new Date().toISOString();
  const payload = input.rows.map((row) => ({
    organization_id: session.organizationId,
    creator_id: creatorId,
    date: row.date,
    platform: input.platform,
    source: input.source,
    data_confidence: input.dataConfidence,
    creator_platform_receipts: row.creatorPlatformReceipts ?? null,
    new_subscribers: row.newSubscribers ?? null,
    first_buyers: row.firstBuyers ?? null,
    active_subscribers: row.activeSubscribers ?? null,
    paying_fans: row.payingFans ?? null,
    imported_at: startedAt,
  }));

  const { data, error } = await client
    .from("creator_revenue_daily")
    .upsert(payload, { onConflict: "creator_id,date,platform,source" })
    .select("id");
  if (error) throw databaseFailure("write", error);
  const written = Array.isArray(data) ? data.length : 0;

  /**
   * The shared ledger writer, so both ingestion paths record a run the same
   * way. This used to be an inline insert here, and it wrote
   * `provider: input.source` (OPERATOR_ENTRY) with `source: input.platform`
   * (ONLYFANS) — the opposite of what those column names mean everywhere else
   * in the schema, where `provider` is the external system. Extracting the
   * helper without moving this call would have left `data_import_runs` holding
   * two contradictory conventions and no way to tell which row used which.
   */
  await recordImportRun(client, {
    organizationId: session.organizationId,
    creatorId,
    provider: input.platform,
    source: input.source,
    idempotencyKey: `revenue:${creatorId}:${input.platform}:${input.source}:${startedAt}`,
    rowsReceived: input.rows.length,
    rowsWritten: written,
    startedAt,
  });

  try {
    await appendAudit(session, "creator.revenue.imported", "creator", creatorId, {
      stageName: found.stage_name,
      platform: input.platform,
      source: input.source,
      dataConfidence: input.dataConfidence,
      rows: input.rows.length,
    });
  } catch (auditError) {
    logEvent("error", "metrics_import.audit_failed", {
      creatorId,
      userId: session.userId,
      message: auditError instanceof Error ? auditError.message : String(auditError),
    });
  }

  return {
    creatorId,
    rowsReceived: input.rows.length,
    rowsWritten: written,
    platform: input.platform,
    source: input.source,
    dataConfidence: input.dataConfidence,
  };
}
