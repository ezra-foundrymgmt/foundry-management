import { describe, expect, it } from "vitest";
import { MockSlackProvider, OnlyFansProviderPlaceholder } from "./index";

describe("mock provider contracts", () => {
  it("returns the same resource for the same Slack idempotency key", async () => {
    const provider = new MockSlackProvider();
    const input = {
      creatorId: "madison",
      stageSlug: "madison",
      audience: "creator" as const,
      idempotencyKey: "creator:madison:slack:creator:v1",
    };
    const first = await provider.createChannel(input);
    const second = await provider.createChannel(input);
    expect(second).toEqual(first);
    expect(first.mode).toBe("MOCK");
  });

  it("does not pretend the revenue placeholder is connected", async () => {
    const health = await new OnlyFansProviderPlaceholder().getConnectionHealth();
    expect(health.status).toBe("NOT_CONFIGURED");
  });
});
