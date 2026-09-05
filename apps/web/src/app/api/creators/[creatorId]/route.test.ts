import { describe, expect, it, vi } from "vitest";
import type * as CreatorsModule from "@/lib/creators";

/**
 * The PATCH route dispatches on which fields the body carries, and two of them
 * were missing from that dispatch.
 *
 * `contractStatus` and `timezone` are the two activation gates that had just
 * been made capable of failing -- previously `convert_prospect_to_creator`
 * asserted 'SIGNED' and defaulted the zone to 'UTC', so neither gate could
 * ever block. Both fields were added to `creatorComplianceSchema` and both got
 * a control in the activation-gates panel, which sends each on its own:
 * `{ contractStatus, updatedAt }` and `{ timezone, updatedAt }`.
 *
 * Neither key was in this route's dispatch condition, so both bodies fell
 * through to `creatorPrioritySchema`, which requires a `priority` field. Every
 * attempt to answer either gate returned 400 INVALID_INPUT and wrote nothing.
 * The whole point of the change was that these gates could now fail; through
 * the product they could not be answered at all.
 *
 * This exercises the handler rather than the schema, because the schema was
 * never the broken part.
 */
/**
 * Declared through the generic rather than as a bare `vi.fn(() => ...)`.
 * Without a signature the recorded call tuple is `[]`, so `calls[0][2]` is a
 * type error and the assertion that the right FIELDS reached the write — the
 * part that actually catches this bug — cannot be written at all.
 */
type CreatorWrite = (session: unknown, creatorId: string, input: unknown) => Promise<unknown>;
const compliance = vi.fn<CreatorWrite>(() => Promise.resolve({ ok: "compliance" }));
const assignment = vi.fn<CreatorWrite>(() => Promise.resolve({ ok: "assignment" }));
const priority = vi.fn<CreatorWrite>(() => Promise.resolve({ ok: "priority" }));

vi.mock("@/lib/auth", () => ({
  AuthorizationError: class extends Error {
    status = 403;
  },
  requirePermission: () =>
    Promise.resolve({
      userId: "11111111-1111-4111-8111-111111111111",
      organizationId: "22222222-2222-4222-8222-222222222222",
      role: "super_admin",
      email: "founder@foundry.test",
    }),
}));

vi.mock("@/lib/creators", async () => {
  const actual = await vi.importActual<typeof CreatorsModule>("@/lib/creators");
  return {
    ...actual,
    updateCreatorCompliance: compliance,
    updateCreatorAssignment: assignment,
    updateCreatorPriority: priority,
  };
});

const { PATCH } = await import("./route");

const CREATOR = "33333333-3333-4333-8333-333333333333";
const UPDATED_AT = "2026-01-01T00:00:00+00:00";

async function patch(body: Record<string, unknown>) {
  const response = await PATCH(
    new Request(`https://app.test/api/creators/${CREATOR}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ creatorId: CREATOR }) },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("creator PATCH dispatch", () => {
  it("routes a contract-status change to the compliance write", async () => {
    compliance.mockClear();
    const result = await patch({ contractStatus: "SIGNED", updatedAt: UPDATED_AT });
    expect(result.status).toBe(200);
    expect(compliance).toHaveBeenCalledOnce();
    expect(compliance.mock.calls[0]?.[2]).toMatchObject({ contractStatus: "SIGNED" });
  });

  it("routes a timezone change to the compliance write", async () => {
    compliance.mockClear();
    const result = await patch({ timezone: "America/Los_Angeles", updatedAt: UPDATED_AT });
    expect(result.status).toBe(200);
    expect(compliance).toHaveBeenCalledOnce();
    expect(compliance.mock.calls[0]?.[2]).toMatchObject({ timezone: "America/Los_Angeles" });
  });

  it("still routes the two original compliance fields", async () => {
    compliance.mockClear();
    expect((await patch({ adultConfirmationStatus: "CONFIRMED", updatedAt: UPDATED_AT })).status).toBe(200);
    expect((await patch({ jurisdictionReviewStatus: "APPROVED", updatedAt: UPDATED_AT })).status).toBe(200);
    expect(compliance).toHaveBeenCalledTimes(2);
  });

  it("still routes assignment and priority to their own writes", async () => {
    assignment.mockClear();
    priority.mockClear();
    expect(
      (await patch({ creatorSuccessUserId: CREATOR, updatedAt: UPDATED_AT })).status,
    ).toBe(200);
    expect((await patch({ priority: "HIGH", updatedAt: UPDATED_AT })).status).toBe(200);
    expect(assignment).toHaveBeenCalledOnce();
    expect(priority).toHaveBeenCalledOnce();
  });

  it("refuses a timezone the runtime cannot resolve rather than silently storing it", async () => {
    compliance.mockClear();
    const result = await patch({ timezone: "Mars/Olympus_Mons", updatedAt: UPDATED_AT });
    expect(result.status).toBe(400);
    expect(compliance).not.toHaveBeenCalled();
  });
});
