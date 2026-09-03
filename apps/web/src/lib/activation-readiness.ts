import "server-only";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * The deterministic answer to "is this creator actually ready to be ACTIVE?".
 *
 * ACTIVE is the most consequential status in CreatorOS: it is what tells Ezra
 * and Payton that a creator is being run properly. Before this existed, ACTIVE
 * meant only that the activation workflow had reached its last step. A step that
 * silently did nothing, a record deleted afterwards, or a direct call to the
 * record port all produced an ACTIVE creator with nothing behind it.
 *
 * Every check reads the record that would have to exist, not a workflow status
 * and not a completion percentage. Workflow status says what the system believes
 * it did; these say what is actually there.
 */
export type ActivationReadinessStatus = "READY" | "WAITING" | "BLOCKED" | "INCOMPLETE";

/**
 * The idempotency key of the competitor-research task activation commissions.
 * Defined here because this module is what asserts the task exists; the record
 * port imports it rather than the two agreeing on a string by coincidence.
 */
export const COMPETITOR_RESEARCH_KEY = (creatorId: string) =>
  `activation:${creatorId}:competitor-research`;

/** What an unsatisfied check of this kind makes the creator. */
export type ActivationReadinessSeverity = Exclude<ActivationReadinessStatus, "READY">;

export interface ActivationReadinessCheck {
  id: string;
  label: string;
  severity: ActivationReadinessSeverity;
  satisfied: boolean;
  detail: string;
}

export interface ActivationReadiness {
  creatorId: string;
  status: ActivationReadinessStatus;
  /** Every unsatisfied check, most severe first. Empty exactly when READY. */
  reasons: string[];
  checks: ActivationReadinessCheck[];
}

/**
 * BLOCKED, then INCOMPLETE, then WAITING.
 *
 * The order is what makes the result actionable rather than merely accurate. A
 * creator with no signed contract and no baseline is BLOCKED: the contract is
 * what a person has to act on, and answering WAITING would send someone to wait
 * for baseline data that should never have been requested in the first place.
 *
 * - BLOCKED — a human authority decision is missing. CreatorOS cannot proceed.
 * - INCOMPLETE — CreatorOS's own provisioning did not produce a record it owes.
 * - WAITING — everything internal is done; external data has not arrived yet.
 */
const SEVERITY_ORDER: readonly ActivationReadinessSeverity[] = [
  "BLOCKED",
  "INCOMPLETE",
  "WAITING",
] as const;

const creatorRowSchema = z.object({
  id: z.string().uuid(),
  stage_name: z.string(),
  status: z.string(),
  contract_status: z.string().nullable(),
  adult_confirmation_status: z.string().nullable(),
  jurisdiction_review_status: z.string().nullable(),
  email: z.string().nullable(),
  timezone: z.string().nullable(),
  assigned_creator_success_user_id: z.string().nullable(),
  assigned_growth_user_id: z.string().nullable(),
});

type Client = NonNullable<ReturnType<typeof createSupabaseAdminClient>>;

/** Filters as [column, value] pairs; a null value means `is null`. */
type Filter = readonly [string, string | boolean | null];

/**
 * Counts matching rows.
 *
 * A failed count throws rather than returning zero. Zero would be read as "the
 * record is missing" and report a healthy creator as INCOMPLETE — or worse, a
 * transient error on the baseline query would let a creator through as READY.
 * Unknown is not zero.
 */
async function countRows(
  client: Client,
  table: string,
  organizationId: string,
  creatorId: string,
  filters: readonly Filter[] = [],
): Promise<number> {
  let query = client
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("creator_id", creatorId);
  for (const [column, value] of filters)
    query = value === null ? query.is(column, null) : query.eq(column, value);
  const { count, error } = await query;
  if (error) throw new Error(`READINESS_COUNT_FAILED:${table}: ${error.message}`);
  if (count === null) throw new Error(`READINESS_COUNT_UNAVAILABLE:${table}`);
  return count;
}

function present(value: string | null, accepted: readonly string[]): boolean {
  return value !== null && accepted.includes(value.toUpperCase());
}

/**
 * Evaluates a creator against every condition ACTIVE is supposed to mean.
 *
 * PROVISION_FILE_STRUCTURE has no check here on purpose: file storage is served
 * by ManualFileStorageProvider, so there is no system-owned record to assert. A
 * check that always passed would be worse than no check.
 */
export async function evaluateActivationReadiness(input: {
  organizationId: string;
  creatorId: string;
}): Promise<ActivationReadiness> {
  const client = createSupabaseAdminClient();
  if (!client) throw new Error("DATABASE_NOT_CONFIGURED");
  const { organizationId, creatorId } = input;

  const creatorResult = await client
    .from("creators")
    .select(
      "id,stage_name,status,contract_status,adult_confirmation_status,jurisdiction_review_status,email,timezone,assigned_creator_success_user_id,assigned_growth_user_id",
    )
    .eq("organization_id", organizationId)
    .eq("id", creatorId)
    .maybeSingle();
  if (creatorResult.error)
    throw new Error(`READINESS_CREATOR_READ_FAILED: ${creatorResult.error.message}`);
  const creator = creatorRowSchema.safeParse(creatorResult.data);
  if (!creator.success) throw new Error("CREATOR_NOT_FOUND");
  const row = creator.data;

  const count = (table: string, filters: readonly Filter[] = []) =>
    countRows(client, table, organizationId, creatorId, filters);

  const [
    boundaries,
    brandProfiles,
    healthScores,
    pnlPeriods,
    inventorySnapshots,
    competitors,
    pillars,
    activationTasks,
    socialAccounts,
    revenueConnections,
    dailySchedules,
    weeklySchedules,
    slackResources,
    notionResources,
    auditEvents,
    baselines,
  ] = await Promise.all([
    count("creator_boundaries", [["active", true]]),
    count("creator_brand_profiles"),
    count("creator_health_scores"),
    count("creator_pnl_periods"),
    count("content_inventory_snapshots"),
    count("tasks", [["idempotency_key", COMPETITOR_RESEARCH_KEY(creatorId)]]),
    count("content_pillars"),
    count("tasks", [["source_type", "CREATOR_ACTIVATION_V1"]]),
    count("social_accounts"),
    count("integration_connections", [["provider", "CREATOR_REVENUE"]]),
    count("creator_report_schedules", [
      ["cadence", "DAILY"],
      ["active", true],
    ]),
    count("creator_report_schedules", [
      ["cadence", "WEEKLY"],
      ["active", true],
    ]),
    count("provisioned_resources", [
      ["provider", "SLACK"],
      ["archived_at", null],
    ]),
    count("provisioned_resources", [
      ["provider", "NOTION"],
      ["archived_at", null],
    ]),
    countAuditEvents(client, organizationId, creatorId),
    count("creator_baselines"),
  ]);

  const checks: ActivationReadinessCheck[] = [
    check(
      "contract-signed",
      "Signed contract",
      "BLOCKED",
      present(row.contract_status, ["SIGNED", "ACTIVE"]),
      `contract_status is ${row.contract_status ?? "not set"}`,
    ),
    check(
      "adult-confirmed",
      "Adult confirmation",
      "BLOCKED",
      present(row.adult_confirmation_status, ["CONFIRMED", "VERIFIED", "COMPLETE", "PASSED"]),
      `adult_confirmation_status is ${row.adult_confirmation_status ?? "not set"}`,
    ),
    check(
      "jurisdiction-approved",
      "Jurisdiction review",
      "BLOCKED",
      present(row.jurisdiction_review_status, ["APPROVED", "COMPLETE", "PASSED"]),
      `jurisdiction_review_status is ${row.jurisdiction_review_status ?? "not set"}`,
    ),
    check(
      "contact-email",
      "Creator contact email",
      "BLOCKED",
      row.email !== null && row.email.length > 0,
      row.email ? "recorded" : "no contact email recorded",
    ),
    check(
      "timezone",
      "Creator timezone",
      "BLOCKED",
      row.timezone !== null && row.timezone.length > 0,
      row.timezone ?? "no timezone recorded, so reports cannot target the creator's day",
    ),
    check(
      "assigned-team",
      "Assigned Foundry owner",
      "BLOCKED",
      row.assigned_creator_success_user_id !== null || row.assigned_growth_user_id !== null,
      "no creator success or growth owner assigned",
    ),
    check(
      "boundaries",
      "Creator boundaries collected",
      "BLOCKED",
      boundaries > 0,
      `${boundaries} active boundary records`,
    ),
    check("brand-profile", "Brand Dossier", "INCOMPLETE", brandProfiles > 0, rows(brandProfiles)),
    check("health-record", "Health record", "INCOMPLETE", healthScores > 0, rows(healthScores)),
    check("pnl-period", "P&L period", "INCOMPLETE", pnlPeriods > 0, rows(pnlPeriods)),
    check(
      "content-inventory",
      "Content inventory",
      "INCOMPLETE",
      inventorySnapshots > 0,
      rows(inventorySnapshots),
    ),
    check(
      "competitor-research",
      "Competitor research commissioned",
      "INCOMPLETE",
      competitors > 0,
      competitors > 0 ? "research task open" : "no competitor research task",
    ),
    check("content-pillars", "Content test board", "INCOMPLETE", pillars > 0, rows(pillars)),
    check(
      "activation-tasks",
      "Initial activation tasks",
      "INCOMPLETE",
      activationTasks > 0,
      rows(activationTasks),
    ),
    check(
      "social-integration-requests",
      "Social integration requests",
      "INCOMPLETE",
      socialAccounts > 0,
      rows(socialAccounts),
    ),
    check(
      "revenue-integration-request",
      "Revenue integration request",
      "INCOMPLETE",
      revenueConnections > 0,
      rows(revenueConnections),
    ),
    check(
      "daily-report-schedule",
      "Daily report schedule",
      "INCOMPLETE",
      dailySchedules > 0,
      rows(dailySchedules),
    ),
    check(
      "weekly-review-schedule",
      "Weekly review schedule",
      "INCOMPLETE",
      weeklySchedules > 0,
      rows(weeklySchedules),
    ),
    // Two channels each: the creator-facing one and the internal one. One
    // present and one missing is a half-provisioned activation, not a ready one.
    check(
      "slack-resources",
      "Slack channels",
      "INCOMPLETE",
      slackResources >= 2,
      `${slackResources} of 2 provisioned channels`,
    ),
    check(
      "notion-resources",
      "Notion pages",
      "INCOMPLETE",
      notionResources >= 2,
      `${notionResources} of 2 provisioned pages`,
    ),
    check(
      "audit-trail",
      "Audit trail",
      "INCOMPLETE",
      auditEvents > 0,
      `${auditEvents} activation audit records`,
    ),
    // The one condition CreatorOS cannot satisfy by itself.
    check(
      "frozen-baseline",
      "Frozen baseline",
      "WAITING",
      baselines > 0,
      baselines > 0
        ? rows(baselines)
        : "no baseline frozen yet, so no report can compare against anything",
    ),
  ];

  const unsatisfied = SEVERITY_ORDER.flatMap((severity) =>
    checks.filter((entry) => !entry.satisfied && entry.severity === severity),
  );
  const status =
    SEVERITY_ORDER.find((severity) => unsatisfied.some((entry) => entry.severity === severity)) ??
    "READY";

  return {
    creatorId,
    status,
    reasons: unsatisfied.map((entry) => `${entry.label}: ${entry.detail}`),
    checks,
  };
}

/**
 * Audit events are keyed by resource, not by creator_id, so they need their own
 * query rather than the shared counter.
 */
async function countAuditEvents(
  client: Client,
  organizationId: string,
  creatorId: string,
): Promise<number> {
  const { count, error } = await client
    .from("audit_events")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("resource_type", "creator")
    .eq("resource_id", creatorId);
  if (error) throw new Error(`READINESS_COUNT_FAILED:audit_events: ${error.message}`);
  if (count === null) throw new Error("READINESS_COUNT_UNAVAILABLE:audit_events");
  return count;
}

function check(
  id: string,
  label: string,
  severity: ActivationReadinessSeverity,
  satisfied: boolean,
  detail: string,
): ActivationReadinessCheck {
  return { id, label, severity, satisfied, detail };
}

function rows(value: number): string {
  return `${value} record${value === 1 ? "" : "s"}`;
}
