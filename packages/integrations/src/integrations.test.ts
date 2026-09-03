import { describe, expect, it } from "vitest";
import {
  LiveNotionProvider,
  LiveSlackProvider,
  lookupNotionPage,
  lookupSlackUser,
  composeChannelName,
  MockSlackProvider,
  OnlyFansProviderPlaceholder,
  provisioningMarker,
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

  it("keeps the discriminator even for a stage name that blows the 80-char limit", () => {
    // Regression: the discriminator was appended last and the composed name was
    // truncated to 80, so a long stage name silently ate the discriminator and
    // reintroduced the collision it exists to prevent. Measured previously: a
    // 72-character slug removed it entirely.
    const longSlug =
      "madison-carter-the-extremely-long-stage-name-that-will-not-fit-in-eighty-characters";
    const a = composeChannelName("creator", longSlug, "aaaaaaaa-0000-4000-8000-00000000aaaa");
    const b = composeChannelName("creator", longSlug, "bbbbbbbb-0000-4000-8000-00000000bbbb");
    expect(a.length).toBeLessThanOrEqual(80);
    expect(b.length).toBeLessThanOrEqual(80);
    expect(a).not.toBe(b);
  });

  it("produces a usable discriminator for a creator id with no alphanumerics", () => {
    // A tail-slice discriminator collapsed to "" here and silently vanished.
    const name = composeChannelName("internal", "madison", "----");
    expect(name).toMatch(/^internal-madison-[0-9a-f]{8}$/);
  });

  /** Slack fake where the requested name is already taken by `existing`. */
  function slackNameTakenFake(existing: { id: string; is_private: boolean }): typeof fetch {
    let requestedName = "";
    return (url, init) => {
      const method = urlOf(url).split("/api/")[1];
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        name?: string;
      };
      if (method === "conversations.create") {
        requestedName = body.name ?? "";
        return Promise.resolve(new Response(JSON.stringify({ ok: false, error: "name_taken" })));
      }
      if (method === "conversations.list")
        return Promise.resolve(
          new Response(
            JSON.stringify({ ok: true, channels: [{ id: existing.id, name: requestedName }] }),
          ),
        );
      if (method === "conversations.info")
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              channel: { id: existing.id, is_private: existing.is_private },
            }),
          ),
        );
      return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    };
  }

  const reconcileInput = {
    creatorId: "aaaaaaaa-0000-4000-8000-00000000aaaa",
    stageSlug: "madison",
    audience: "creator" as const,
    idempotencyKey: "slack:reconcile",
  };

  it("refuses to bind a creator channel to a reconciled public channel", async () => {
    // name_taken recovery must not adopt whatever already held the name: a
    // public channel would publish creator material to the whole workspace.
    const provider = new LiveSlackProvider(
      "token",
      new MemoryResourceStore(),
      slackNameTakenFake({ id: "C_PUBLIC", is_private: false }),
    );
    await expect(provider.createChannel(reconcileInput)).rejects.toThrow(
      "RECONCILED_CHANNEL_NOT_PRIVATE",
    );
  });

  it("adopts a reconciled channel that is genuinely private", async () => {
    const provider = new LiveSlackProvider(
      "token",
      new MemoryResourceStore(),
      slackNameTakenFake({ id: "C_PRIVATE", is_private: true }),
    );
    expect((await provider.createChannel(reconcileInput)).externalId).toBe("C_PRIVATE");
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

  function notionFake(options: {
    searchResults: unknown[];
    childrenByPage: Record<string, string[]>;
    onCreate?: () => void;
  }): typeof fetch {
    return (url, init) => {
      const target = urlOf(url);
      if (target.endsWith("/search"))
        return Promise.resolve(
          new Response(JSON.stringify({ results: options.searchResults, has_more: false })),
        );
      const children = /\/blocks\/([^/?]+)\/children/.exec(target);
      if (children && (init?.method ?? "GET") === "GET") {
        const markers = options.childrenByPage[children[1] ?? ""] ?? [];
        return Promise.resolve(
          new Response(
            JSON.stringify({
              results: markers.map((text) => ({
                paragraph: { rich_text: [{ plain_text: text }] },
              })),
            }),
          ),
        );
      }
      options.onCreate?.();
      return Promise.resolve(new Response(JSON.stringify({ id: "page-duplicate" })));
    };
  }

  it("recovers an orphaned Notion page carrying this creator's provisioning marker", async () => {
    // Simulates a crash between creating the page and persisting its id: the
    // store is empty, but the page already exists under the parent.
    let created = 0;
    const request = notionFake({
      searchResults: [
        {
          id: "page-existing",
          archived: false,
          parent: { page_id: "parent" },
          properties: { title: { title: [{ plain_text: "Madison · Creator Hub" }] } },
        },
      ],
      childrenByPage: { "page-existing": [provisioningMarker("notion:1")] },
      onCreate: () => {
        created += 1;
      },
    });
    const provider = new LiveNotionProvider("token", "parent", new MemoryResourceStore(), request);
    const resource = await provider.createCreatorHub({
      creatorId: "1",
      stageName: "Madison",
      idempotencyKey: "notion:1",
    });
    expect(resource.externalId).toBe("page-existing");
    expect(created).toBe(0);
  });

  it("never adopts a namesake creator's hub page", async () => {
    // The critical case: two creators share the stage name "Madison", so both
    // hubs have the identical title. Matching on title alone would hand creator
    // B creator A's page — and that page is readable by the creator.
    let created = 0;
    const request = notionFake({
      searchResults: [
        {
          id: "page-belonging-to-creator-a",
          archived: false,
          parent: { page_id: "parent" },
          properties: { title: { title: [{ plain_text: "Madison · Creator Hub" }] } },
        },
      ],
      // That page carries creator A's marker, not creator B's.
      childrenByPage: { "page-belonging-to-creator-a": [provisioningMarker("notion:creator-a")] },
      onCreate: () => {
        created += 1;
      },
    });
    const provider = new LiveNotionProvider("token", "parent", new MemoryResourceStore(), request);
    const resource = await provider.createCreatorHub({
      creatorId: "creator-b",
      stageName: "Madison",
      idempotencyKey: "notion:creator-b",
    });
    expect(resource.externalId).toBe("page-duplicate");
    expect(resource.externalId).not.toBe("page-belonging-to-creator-a");
    expect(created).toBe(1);
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

/**
 * The Slack account behind a member ID has to be a real, human, current member
 * of this workspace before anyone can link it to a CreatorOS identity. Every
 * case below would otherwise become a live authorization grant.
 */
describe("Slack user lookup", () => {
  function respond(body: unknown, status = 200) {
    return () => Promise.resolve(new Response(JSON.stringify(body), { status }));
  }

  it("returns the account's team and display name", async () => {
    const result = await lookupSlackUser(
      "xoxb-token",
      "U0PAYTON",
      respond({
        ok: true,
        user: { id: "U0PAYTON", team_id: "T0FOUNDRY", profile: { display_name: "payton" } },
      }),
    );

    expect(result).toEqual({
      slackUserId: "U0PAYTON",
      slackTeamId: "T0FOUNDRY",
      displayName: "payton",
    });
  });

  it("falls back through real name to handle when no display name is set", async () => {
    const result = await lookupSlackUser(
      "xoxb-token",
      "U0PAYTON",
      respond({
        ok: true,
        user: {
          id: "U0PAYTON",
          team_id: "T0FOUNDRY",
          name: "payton.handle",
          profile: { display_name: "  ", real_name: "Payton" },
        },
      }),
    );

    expect(result?.displayName).toBe("Payton");
  });

  it("treats an unknown member ID as an answer, not an error", async () => {
    const result = await lookupSlackUser(
      "xoxb-token",
      "U0TYPO",
      respond({ ok: false, error: "user_not_found" }),
    );

    expect(result).toBeNull();
  });

  it("refuses deactivated accounts and bots", async () => {
    const deleted = await lookupSlackUser(
      "xoxb-token",
      "U0GONE",
      respond({
        ok: true,
        user: { id: "U0GONE", team_id: "T0FOUNDRY", deleted: true, profile: {} },
      }),
    );
    // A bot carrying a founder's permissions is not an identity anyone granted.
    const bot = await lookupSlackUser(
      "xoxb-token",
      "U0BOT",
      respond({
        ok: true,
        user: { id: "U0BOT", team_id: "T0FOUNDRY", is_bot: true, profile: {} },
      }),
    );

    expect(deleted).toBeNull();
    expect(bot).toBeNull();
  });

  it("raises rather than denying when Slack itself fails", async () => {
    // A revoked token answering "not found" would silently look like a bad ID.
    await expect(
      lookupSlackUser("xoxb-token", "U0PAYTON", respond({ ok: false, error: "invalid_auth" })),
    ).rejects.toThrow(/SLACK_invalid_auth/);
    await expect(
      lookupSlackUser("xoxb-token", "U0PAYTON", respond({}, 500) as unknown as typeof fetch),
    ).rejects.toThrow(/SLACK_HTTP_500/);
  });

  it("never puts the token in the URL", async () => {
    let seenUrl = "";
    await lookupSlackUser("xoxb-secret", "U0PAYTON", ((url: string) => {
      seenUrl = url;
      return Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, user: { id: "U0PAYTON", team_id: "T0FOUNDRY", profile: {} } }),
        ),
      );
    }) as unknown as typeof fetch);

    expect(seenUrl).not.toContain("xoxb-secret");
    expect(seenUrl).toContain("U0PAYTON");
  });
});

/**
 * The Creator Hub root has to be a page this integration can actually reach
 * before anything is written under it.
 */
describe("Notion page lookup", () => {
  const PAGE = "aaaaaaaabbbbccccddddeeeeeeeeeeee";

  function respond(body: unknown, status = 200) {
    return () => Promise.resolve(new Response(JSON.stringify(body), { status }));
  }

  it("reads the title from whichever property carries it", async () => {
    // Notion names the title property differently per database and omits it on
    // workspace pages, so it has to be found by type, not by a fixed key.
    const result = await lookupNotionPage(
      "secret_token",
      PAGE,
      respond({
        id: PAGE,
        properties: {
          Owner: { type: "people" },
          "Page name": { type: "title", title: [{ plain_text: "Creators" }] },
        },
      }),
    );

    expect(result).toEqual({ pageId: PAGE, title: "Creators", archived: false });
  });

  it("joins a title split across rich-text fragments", async () => {
    const result = await lookupNotionPage(
      "secret_token",
      PAGE,
      respond({
        id: PAGE,
        properties: {
          title: { type: "title", title: [{ plain_text: "Foundry " }, { plain_text: "Creators" }] },
        },
      }),
    );

    expect(result?.title).toBe("Foundry Creators");
  });

  it("falls back to Untitled rather than guessing", async () => {
    const result = await lookupNotionPage("secret_token", PAGE, respond({ id: PAGE }));

    expect(result?.title).toBe("Untitled");
  });

  it("treats an inaccessible page the same as a missing one", async () => {
    // Notion answers 404 for a page that does not exist and for one this
    // integration was never shared on. Both mean: do not write here.
    expect(await lookupNotionPage("secret_token", PAGE, respond({}, 404))).toBeNull();
    expect(await lookupNotionPage("secret_token", PAGE, respond({}, 403))).toBeNull();
  });

  it("reports an archived page instead of hiding it", async () => {
    // A silent null would read as "no such page" when the truth is "unarchive
    // it", which sends the admin looking for the wrong problem.
    const result = await lookupNotionPage(
      "secret_token",
      PAGE,
      respond({ id: PAGE, archived: true, properties: {} }),
    );

    expect(result).toMatchObject({ archived: true });
  });

  it("raises when Notion itself fails", async () => {
    await expect(
      lookupNotionPage("secret_token", PAGE, respond({ code: "internal_server_error" }, 500)),
    ).rejects.toThrow(/NOTION_internal_server_error/);
  });

  it("never puts the token in the URL", async () => {
    let seenUrl = "";
    await lookupNotionPage("secret_token_value", PAGE, ((url: string) => {
      seenUrl = url;
      return Promise.resolve(new Response(JSON.stringify({ id: PAGE })));
    }) as unknown as typeof fetch);

    expect(seenUrl).not.toContain("secret_token_value");
    expect(seenUrl).toContain(PAGE);
  });
});
