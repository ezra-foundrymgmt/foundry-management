import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingCreator } from "@creatoros/workflows";

/**
 * The ACTIVE invariant, enforced at the only place ACTIVE is written.
 *
 * Reaching COMPLETE_ACTIVATION says the earlier steps ran. It does not say they
 * left anything behind, and it says nothing about a record deleted since. If the
 * gate is not here it is nowhere: the workflow will happily complete a run whose
 * provisioning quietly produced nothing.
 */
interface Write {
  table: string;
  op: "update" | "insert" | "upsert";
  values: Record<string, unknown>;
}

const writes: Write[] = [];

function makeQuery(table: string) {
  const chain: Record<string, unknown> = {};
  const capture = (op: Write["op"]) => (values: Record<string, unknown>) => {
    writes.push({ table, op, values });
    return chain;
  };
  chain["update"] = capture("update");
  chain["insert"] = capture("insert");
  chain["upsert"] = capture("upsert");
  chain["eq"] = () => chain;
  chain["then"] = (resolve: (value: unknown) => unknown) => resolve({ error: null });
  return chain;
}

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ from: (table: string) => makeQuery(table) }),
}));

const evaluateActivationReadiness =
  vi.fn<() => Promise<{ status: string; reasons: string[]; checks: unknown[] }>>();
vi.mock("@/lib/activation-readiness", () => ({
  evaluateActivationReadiness: () => evaluateActivationReadiness(),
}));

const { SupabaseActivationRecordPort } = await import("./activation-records");

const ORG = "11111111-1111-4111-8111-111111111111";
const ACTOR = "33333333-3333-4333-8333-333333333333";

const creator: OnboardingCreator = {
  id: "22222222-2222-4222-8222-222222222222",
  creatorNumber: "CRT-000001",
  stageName: "Madison Carter",
  stageSlug: "madison-carter",
  status: "ONBOARDING",
  contractSigned: true,
  adultConfirmed: true,
  jurisdictionApproved: true,
  contactEmail: "madison@example.com",
  timezone: "America/Los_Angeles",
  assignedTeam: true,
  boundariesCollected: true,
  baselineReady: true,
};

function port() {
  return new SupabaseActivationRecordPort(ORG, ACTOR);
}

function statusWrites() {
  return writes.filter((write) => write.table === "creators" && "status" in write.values);
}

beforeEach(() => {
  writes.length = 0;
  evaluateActivationReadiness.mockReset();
  evaluateActivationReadiness.mockResolvedValue({ status: "READY", reasons: [], checks: [{}, {}] });
});

describe("completing an activation", () => {
  it("sets ACTIVE and records it when the creator is genuinely ready", async () => {
    await port().completeActivation(creator);

    expect(statusWrites().map((write) => write.values["status"])).toEqual(["ACTIVE"]);
    const audit = writes.find((write) => write.table === "audit_events");
    expect(audit?.values).toMatchObject({
      action: "creator.activation.completed",
      actor_type: "workflow",
      resource_type: "creator",
      resource_id: creator.id,
    });
  });

  for (const status of ["WAITING", "BLOCKED", "INCOMPLETE"])
    it(`refuses to set ACTIVE when readiness is ${status}`, async () => {
      evaluateActivationReadiness.mockResolvedValue({
        status,
        reasons: ["Frozen baseline: no baseline frozen yet"],
        checks: [],
      });

      await expect(port().completeActivation(creator)).rejects.toThrow(
        new RegExp(`CREATOR_NOT_READY_FOR_ACTIVE:${status}`),
      );
      // The refusal has to happen before the write, not be reported after it.
      expect(statusWrites()).toEqual([]);
    });

  it("carries the reasons into the error so the failure explains itself", async () => {
    evaluateActivationReadiness.mockResolvedValue({
      status: "INCOMPLETE",
      reasons: ["Slack channels: 1 of 2 provisioned channels", "Brand Dossier: 0 records"],
      checks: [],
    });

    await expect(port().completeActivation(creator)).rejects.toThrow(/1 of 2 provisioned channels/);
  });
});

describe("activation audit trail", () => {
  it("records the start of an activation", async () => {
    await port().recordActivationStarted(creator);

    const audit = writes.find((write) => write.table === "audit_events");
    expect(audit?.values).toMatchObject({
      action: "creator.activation.started",
      actor_type: "workflow",
      actor_service: "CREATOR_ACTIVATION_V1",
      actor_user_id: ACTOR,
      organization_id: ORG,
    });
  });

  it("never writes creator data into the audit metadata", async () => {
    await port().recordActivationStarted(creator);

    const audit = writes.find((write) => write.table === "audit_events");
    // The trail records that activation happened, not the creator's details.
    expect(JSON.stringify(audit?.values["metadata_json"])).not.toContain("madison@example.com");
  });
});
