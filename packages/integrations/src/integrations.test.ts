import { describe, expect, it } from "vitest";
import {
  LiveNotionProvider,
  LiveSlackProvider,
  MockSlackProvider,
  OnlyFansProviderPlaceholder,
  type ProviderResourceStore,
  type ProvisionedResource,
} from "./index";

class MemoryResourceStore implements ProviderResourceStore {
  resources = new Map<string, ProvisionedResource>();
  find(key: string) {
    return Promise.resolve(this.resources.get(key) ?? null);
  }
  save(key: string, resource: ProvisionedResource) {
    this.resources.set(key, resource);
    return Promise.resolve();
  }
}

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

describe("live provider adapters", () => {
  it("uses the resource registry before making a duplicate Slack call", async () => {
    const store = new MemoryResourceStore();
    let calls = 0;
    const request: typeof fetch = () => {
      calls += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, channel: { id: "C123", name: "creator-madison" } }),
        ),
      );
    };
    const provider = new LiveSlackProvider("token", store, request);
    const input = {
      creatorId: "1",
      stageSlug: "Madison Carter",
      audience: "creator" as const,
      idempotencyKey: "slack:1",
    };
    expect((await provider.createChannel(input)).externalId).toBe("C123");
    expect((await provider.createChannel(input)).externalId).toBe("C123");
    expect(calls).toBe(1);
  });

  it("creates a minimal Notion projection and reuses its deterministic key", async () => {
    const store = new MemoryResourceStore();
    const bodies: string[] = [];
    const request: typeof fetch = (_url, init) => {
      bodies.push(typeof init?.body === "string" ? init.body : "");
      return Promise.resolve(new Response(JSON.stringify({ id: "page-123" }), { status: 200 }));
    };
    const provider = new LiveNotionProvider("token", "parent", store, request);
    const input = { creatorId: "1", stageName: "Madison", idempotencyKey: "notion:1" };
    await provider.createCreatorHub(input);
    await provider.createCreatorHub(input);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain("email");
  });
});
