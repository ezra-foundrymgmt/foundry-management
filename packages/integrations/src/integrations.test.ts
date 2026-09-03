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

function urlOf(target: RequestInfo | URL): string {
  if (typeof target === "string") return target;
  return target instanceof URL ? target.href : target.url;
}

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

  it("distinguishes two creators that share a stage name", async () => {
    // Without a discriminator both creators generate the same channel name and
    // the name_taken reconcile binds the second creator to the first's channel.
    const names: string[] = [];
    const request: typeof fetch = (_url, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        name?: string;
      };
      if (body.name) names.push(body.name);
      return Promise.resolve(new Response(JSON.stringify({ ok: true, channel: { id: "C1" } })));
    };
    const provider = new LiveSlackProvider("token", new MemoryResourceStore(), request);
    await provider.createChannel({
      creatorId: "aaaaaaaa-0000-4000-8000-00000000aaaa",
      stageSlug: "madison",
      audience: "creator",
      idempotencyKey: "slack:a",
    });
    await provider.createChannel({
      creatorId: "bbbbbbbb-0000-4000-8000-00000000bbbb",
      stageSlug: "madison",
      audience: "creator",
      idempotencyKey: "slack:b",
    });
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
  });

  it("creates a minimal Notion projection and reuses its deterministic key", async () => {
    const store = new MemoryResourceStore();
    const calls: Array<{ url: string; body: string }> = [];
    const request: typeof fetch = (url, init) => {
      calls.push({
        url: urlOf(url),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return Promise.resolve(new Response(JSON.stringify({ id: "page-123" }), { status: 200 }));
    };
    const provider = new LiveNotionProvider("token", "parent", store, request);
    const input = { creatorId: "1", stageName: "Madison", idempotencyKey: "notion:1" };
    await provider.createCreatorHub(input);
    await provider.createCreatorHub(input);
    // First call reconciles then creates; the second is served entirely from the
    // resource store, so exactly one page is ever created.
    const creates = calls.filter((call) => call.url.endsWith("/pages"));
    expect(creates).toHaveLength(1);
    expect(creates[0]?.body).not.toContain("email");
  });

  it("recovers an orphaned Notion page instead of creating a duplicate", async () => {
    // Simulates a crash between creating the page and persisting its id: the
    // store is empty, but the page already exists under the parent.
    const store = new MemoryResourceStore();
    let created = 0;
    const request: typeof fetch = (url) => {
      const target = urlOf(url);
      if (target.endsWith("/search"))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              results: [
                {
                  id: "page-existing",
                  archived: false,
                  parent: { page_id: "parent" },
                  properties: { title: { title: [{ plain_text: "Madison · Creator Hub" }] } },
                },
              ],
            }),
          ),
        );
      created += 1;
      return Promise.resolve(new Response(JSON.stringify({ id: "page-duplicate" })));
    };
    const provider = new LiveNotionProvider("token", "parent", store, request);
    const resource = await provider.createCreatorHub({
      creatorId: "1",
      stageName: "Madison",
      idempotencyKey: "notion:1",
    });
    expect(resource.externalId).toBe("page-existing");
    expect(created).toBe(0);
  });

  it("ignores an archived or differently-parented page when reconciling", async () => {
    const request: typeof fetch = (url) => {
      if (urlOf(url).endsWith("/search"))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              results: [
                {
                  id: "archived",
                  archived: true,
                  parent: { page_id: "parent" },
                  properties: { title: { title: [{ plain_text: "Madison · Creator Hub" }] } },
                },
                {
                  id: "other-workspace",
                  archived: false,
                  parent: { page_id: "different-parent" },
                  properties: { title: { title: [{ plain_text: "Madison · Creator Hub" }] } },
                },
              ],
            }),
          ),
        );
      return Promise.resolve(new Response(JSON.stringify({ id: "page-fresh" })));
    };
    const provider = new LiveNotionProvider("token", "parent", new MemoryResourceStore(), request);
    const resource = await provider.createCreatorHub({
      creatorId: "1",
      stageName: "Madison",
      idempotencyKey: "notion:1",
    });
    expect(resource.externalId).toBe("page-fresh");
  });
});
