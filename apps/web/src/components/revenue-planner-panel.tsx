"use client";

import { useState } from "react";
import { FUNNEL_STAGES } from "@creatoros/domain";

/**
 * "We want $X from this creator next month — what has to be true?"
 *
 * The panel's job is as much to show what CANNOT be planned as what can. A
 * stage the creator has never measured renders as an explicit gap naming the
 * measurement that would unblock it, never as a number — because a
 * required-reach figure invented from an assumed conversion rate looks exactly
 * like a measured one once it is on the screen and in front of a creator.
 */

const STAGE_LABELS: Record<string, string> = {
  reach: "Reach",
  profileVisits: "Profile visits",
  outboundClicks: "Outbound clicks",
  newSubscribers: "New subscribers",
  firstBuyers: "First-time buyers",
};

const BLOCKED_REASONS: Record<string, string> = {
  RATE_NOT_MEASURED: "This conversion has never been measured for this creator.",
  RATE_IS_ZERO: "The measured conversion is zero, so no volume reaches the target.",
  UPSTREAM_UNKNOWN: "Blocked by the gap below — fix that one first.",
};

const MESSAGES: Record<string, string> = {
  NO_BASELINE_FROZEN: "Freeze a baseline first. A plan needs measured conversion rates.",
  CREATOR_NOT_FOUND: "That creator is not in this organization.",
  PERMISSION_DENIED: "Viewing plans requires analytics permissions.",
  AUTHENTICATION_REQUIRED: "Your session expired. Sign in again.",
  PERIOD_START_AFTER_END: "The period ends before it starts.",
  INVALID_INPUT: "Check the target and the period.",
  DATABASE_NOT_CONFIGURED: "The live database is not configured in this environment.",
  PLANNER_DATABASE_FAILED: "The plan could not be built. Nothing changed.",
  PLAN_FAILED: "Something went wrong building the plan.",
};

interface Stage {
  stage: string;
  required: number | null;
  conversionRate: number | null;
  confidence: string;
  blockedBy?: string;
}

interface PlanResponse {
  baselineVersion: number;
  baselinePeriod: { start: string; end: string };
  plan: {
    targetRevenue: number;
    revenuePerFirstBuyer: number | null;
    stages: Stage[];
    complete: boolean;
    unplannable: string[];
  };
  scenarios: Array<{ name: string; plan: { stages: Stage[] } }>;
  pace: {
    expectedByNow: number;
    achievedRevenue: number;
    varianceToDate: number;
    requiredDailyRunRate: number | null;
    status: string;
  };
}

const whole = new Intl.NumberFormat("en-US");
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function RevenuePlannerPanel({ creatorId }: { creatorId: string }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<PlanResponse | null>(null);

  async function build() {
    setBusy(true);
    setError("");
    const response = await fetch(`/api/creators/${creatorId}/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetRevenue: Number(target),
        periodStart,
        periodEnd,
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      data?: PlanResponse;
      error?: string;
    };
    setBusy(false);
    if (!response.ok || !payload.data) {
      setResult(null);
      setError((payload.error && MESSAGES[payload.error]) ?? "The plan could not be built.");
      return;
    }
    setResult(payload.data);
  }

  if (!open)
    return (
      <button className="button" onClick={() => setOpen(true)}>
        Plan a revenue target
      </button>
    );

  return (
    <section className="card card-pad" style={{ display: "grid", gap: 10 }}>
      <strong style={{ fontSize: 12 }}>Plan a revenue target</strong>
      <p className="subtitle" style={{ fontSize: 10, margin: 0, lineHeight: 1.5 }}>
        Worked backwards from this creator&apos;s own measured conversion rates. A
        stage they have never measured is shown as a gap, not as a number.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        <label style={{ display: "grid", gap: 3, fontSize: 10.5 }}>
          Target revenue
          <input
            className="input"
            inputMode="numeric"
            value={target}
            placeholder="40000"
            onChange={(event) => setTarget(event.target.value.replace(/[^\d.]/g, ""))}
          />
        </label>
        <label style={{ display: "grid", gap: 3, fontSize: 10.5 }}>
          Period start
          <input
            className="input"
            type="date"
            value={periodStart}
            onChange={(event) => setPeriodStart(event.target.value)}
          />
        </label>
        <label style={{ display: "grid", gap: 3, fontSize: 10.5 }}>
          Period end
          <input
            className="input"
            type="date"
            value={periodEnd}
            onChange={(event) => setPeriodEnd(event.target.value)}
          />
        </label>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button
          className="button primary"
          disabled={busy || target === "" || periodStart === "" || periodEnd === ""}
          onClick={() => void build()}
        >
          {busy ? "Building…" : "Build plan"}
        </button>
        <button className="button" disabled={busy} onClick={() => setOpen(false)}>
          Close
        </button>
      </div>

      {error ? (
        <span role="alert" style={{ fontSize: 10, color: "var(--red)" }}>
          {error}
        </span>
      ) : null}

      {result ? (
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ fontSize: 10, color: "var(--ink-soft)" }}>
            From baseline v{result.baselineVersion} ({result.baselinePeriod.start} →{" "}
            {result.baselinePeriod.end}).{" "}
            {result.plan.revenuePerFirstBuyer === null
              ? "Revenue per buyer could not be measured."
              : `${money.format(result.plan.revenuePerFirstBuyer)} per first-time buyer.`}
          </div>

          {result.plan.complete ? null : (
            <p
              role="status"
              style={{ fontSize: 10.5, margin: 0, color: "var(--amber, var(--ink))" }}
            >
              Partial plan: {result.plan.unplannable.length} of {FUNNEL_STAGES.length} stages could
              not be planned from measured data.
            </p>
          )}

          <div style={{ display: "grid", gap: 4 }}>
            {result.plan.stages.map((stage) => (
              <div
                key={stage.stage}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "baseline",
                  fontSize: 11,
                  borderBottom: "1px solid var(--line, rgba(0,0,0,.06))",
                  paddingBottom: 4,
                }}
              >
                <span style={{ flex: 1 }}>{STAGE_LABELS[stage.stage] ?? stage.stage}</span>
                {stage.required === null ? (
                  <span style={{ color: "var(--ink-soft)", fontSize: 10, flex: 2 }}>
                    Not plannable — {BLOCKED_REASONS[stage.blockedBy ?? ""] ?? "unknown reason"}
                  </span>
                ) : (
                  <>
                    <strong style={{ fontVariantNumeric: "tabular-nums" }}>
                      {whole.format(stage.required)}
                    </strong>
                    <span style={{ fontSize: 9.5, color: "var(--ink-soft)", width: 110 }}>
                      {stage.conversionRate === null
                        ? ""
                        : `at ${(stage.conversionRate < 1
                            ? stage.conversionRate * 100
                            : stage.conversionRate
                          ).toFixed(2)}${stage.conversionRate < 1 ? "%" : " each"}`}
                    </span>
                  </>
                )}
              </div>
            ))}
          </div>

          <div style={{ fontSize: 10.5 }}>
            <strong>Pace: {result.pace.status.replace(/_/g, " ").toLowerCase()}</strong>
            {" — "}
            {money.format(result.pace.achievedRevenue)} of an expected{" "}
            {money.format(result.pace.expectedByNow)} by now.
            {result.pace.requiredDailyRunRate === null
              ? " The period is over."
              : ` ${money.format(result.pace.requiredDailyRunRate)}/day remaining to hit it.`}
          </div>

          <div style={{ display: "grid", gap: 3, fontSize: 10 }}>
            <span style={{ color: "var(--ink-soft)" }}>If a rate improved 10%:</span>
            {result.scenarios.map((scenario) => {
              const reach = scenario.plan.stages.find((s) => s.stage === "reach");
              return (
                <div key={scenario.name} style={{ display: "flex", gap: 8 }}>
                  <span style={{ flex: 1 }}>{scenario.name}</span>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>
                    {reach?.required === null || reach?.required === undefined
                      ? "reach still not plannable"
                      : `${whole.format(reach.required)} reach`}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}
