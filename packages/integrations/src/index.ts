import { assertProjectableFields } from "./projection";
export * from "./projection";
export type ConnectionStatus =
  | "NOT_CONFIGURED"
  | "CONFIGURED"
  | "CONNECTING"
  | "CONNECTED"
  | "DEGRADED"
  | "ERROR"
  | "DISCONNECTED";
export type ProviderMode = "MOCK" | "LIVE" | "PLACEHOLDER";

export interface ProvisionedResource {
  externalId: string;
  name: string;
  provider: string;
  mode: ProviderMode;
}

export interface SlackProvider {
  createChannel(input: {
    creatorId: string;
    stageSlug: string;
    audience: "creator" | "internal";
    idempotencyKey: string;
  }): Promise<ProvisionedResource>;
  inviteMembers(resourceId: string, memberIds: string[]): Promise<void>;
  setTopic(resourceId: string, topic: string): Promise<void>;
  postMessage(resourceId: string, message: string): Promise<void>;
  archiveChannel(resourceId: string): Promise<void>;
}

export interface NotionProvider {
  createCreatorHub(input: {
    creatorId: string;
    stageName: string;
    idempotencyKey: string;
  }): Promise<ProvisionedResource>;
  createInternalResources(input: {
    creatorId: string;
    stageName: string;
    idempotencyKey: string;
  }): Promise<ProvisionedResource>;
  updateCreatorHub(resourceId: string, fields: Readonly<Record<string, unknown>>): Promise<void>;
  archiveCreatorHub(resourceId: string): Promise<void>;
}

export interface FileStorageProvider {
  createCreatorStructure(input: {
    creatorId: string;
    stageSlug: string;
    idempotencyKey: string;
  }): Promise<ProvisionedResource>;
}

export interface CreatorRevenueProvider {
  getConnectionHealth(): Promise<{ status: ConnectionStatus; checkedAt: string }>;
  getDailyRevenue(range: {
    start: string;
    end: string;
  }): Promise<Array<{ date: string; revenue: number | null; source: string }>>;
}

export interface IntelligenceProvider {
  name: string;
  enrichDiagnosis(
    input: Readonly<Record<string, unknown>>,
  ): Promise<{ summary: string; suggestions: string[] }>;
}

export interface ProviderResourceStore {
  find(idempotencyKey: string): Promise<ProvisionedResource | null>;
  save(idempotencyKey: string, resource: ProvisionedResource): Promise<void>;
}

type FetchLike = typeof fetch;

class ProviderApiError extends Error {
  constructor(
    readonly provider: "SLACK" | "NOTION",
    readonly code: string,
    message?: string,
  ) {
    super(message ? `${provider}_${code}: ${message}` : `${provider}_${code}`);
  }
}

interface SlackResponse {
  ok: boolean;
  error?: string;
  channel?: { id?: string; name?: string };
  channels?: Array<{ id?: string; name?: string }>;
  response_metadata?: { next_cursor?: string };
}

/** Live Slack Web API adapter. Credentials stay in the server process. */
export class LiveSlackProvider implements SlackProvider {
  constructor(
    private readonly token: string,
    private readonly store: ProviderResourceStore,
    private readonly request: FetchLike = fetch,
  ) {}

  async createChannel(input: {
    creatorId: string;
    stageSlug: string;
    audience: "creator" | "internal";
    idempotencyKey: string;
  }): Promise<ProvisionedResource> {
    const existing = await this.store.find(input.idempotencyKey);
    if (existing) return existing;
    // The creator discriminator matters: two creators sharing a stage name would
    // otherwise generate the same channel name, and the name_taken reconcile
    // below would bind the second creator to the first creator's channel.
    const discriminator = input.creatorId
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(-6)
      .toLowerCase();
    const name = normalizeSlackChannel(
      `${input.audience === "creator" ? "creator" : "internal"}-${input.stageSlug}-${discriminator}`,
    );
    const created = await this.#call("conversations.create", { name, is_private: true });
    let externalId = created.channel?.id;
    if (!created.ok && created.error === "name_taken") externalId = await this.#findChannel(name);
    if (!externalId) throw new ProviderApiError("SLACK", created.error ?? "CREATE_FAILED");
    const resource: ProvisionedResource = {
      externalId,
      name,
      provider: "SLACK",
      mode: "LIVE",
    };
    await this.store.save(input.idempotencyKey, resource);
    return resource;
  }

  async inviteMembers(resourceId: string, memberIds: string[]): Promise<void> {
    if (!memberIds.length) return;
    await this.#requireOk("conversations.invite", {
      channel: resourceId,
      users: memberIds.join(","),
    });
  }
  async setTopic(resourceId: string, topic: string): Promise<void> {
    await this.#requireOk("conversations.setTopic", {
      channel: resourceId,
      topic: topic.slice(0, 250),
    });
  }
  async postMessage(resourceId: string, message: string): Promise<void> {
    await this.#requireOk("chat.postMessage", { channel: resourceId, text: message });
  }
  async archiveChannel(resourceId: string): Promise<void> {
    await this.#requireOk("conversations.archive", { channel: resourceId });
  }
  async #findChannel(name: string): Promise<string | undefined> {
    let cursor = "";
    do {
      const response = await this.#call("conversations.list", {
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      if (!response.ok) throw new ProviderApiError("SLACK", response.error ?? "LIST_FAILED");
      const match = response.channels?.find((channel) => channel.name === name);
      if (match?.id) return match.id;
      cursor = response.response_metadata?.next_cursor ?? "";
    } while (cursor);
    return undefined;
  }
  async #requireOk(method: string, body: Record<string, unknown>): Promise<void> {
    const response = await this.#call(method, body);
    if (!response.ok) throw new ProviderApiError("SLACK", response.error ?? "API_ERROR");
  }
  async #call(method: string, body: Record<string, unknown>): Promise<SlackResponse> {
    const response = await this.request(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new ProviderApiError("SLACK", `HTTP_${response.status}`);
    return (await response.json()) as SlackResponse;
  }
}

/** Live Notion adapter that projects only a minimal, non-sensitive creator hub. */
export class LiveNotionProvider implements NotionProvider {
  constructor(
    private readonly token: string,
    private readonly parentPageId: string,
    private readonly store: ProviderResourceStore,
    private readonly request: FetchLike = fetch,
  ) {}

  createCreatorHub(input: { creatorId: string; stageName: string; idempotencyKey: string }) {
    return this.#createPage(input.idempotencyKey, `${input.stageName} · Creator Hub`, [
      "Shared priorities, deliverables, and approved operating notes.",
    ]);
  }
  createInternalResources(input: { creatorId: string; stageName: string; idempotencyKey: string }) {
    return this.#createPage(input.idempotencyKey, `${input.stageName} · Internal Operations`, [
      "Internal planning projection. CreatorOS remains the source of truth.",
    ]);
  }
  async updateCreatorHub(resourceId: string, fields: Readonly<Record<string, unknown>>) {
    // Every value crossing into a creator-readable page passes the
    // classification boundary first. It throws rather than truncating: a
    // truncated secret is still a leaked secret.
    const safe = assertProjectableFields(fields);
    const lines = Object.entries(safe).map(([field, value]) =>
      paragraph(`CreatorOS ${field}: ${value.slice(0, 1800)}`),
    );
    if (!lines.length) return;
    await this.#call(`/blocks/${resourceId}/children`, "PATCH", { children: lines });
  }
  async archiveCreatorHub(resourceId: string) {
    await this.#call(`/pages/${resourceId}`, "PATCH", { archived: true });
  }
  async #createPage(key: string, title: string, notes: string[]): Promise<ProvisionedResource> {
    const existing = await this.store.find(key);
    if (existing) return existing;
    // Notion has no create-if-absent and no name_taken error, so a crash
    // between creating the page and persisting its id would orphan the page and
    // let a retry create "Madison Hub 2". Reconciling by title under the
    // configured parent first closes that window, mirroring the Slack
    // name_taken path.
    const reconciled = await this.#findPage(title);
    if (reconciled) {
      const recovered: ProvisionedResource = {
        externalId: reconciled,
        name: title,
        provider: "NOTION",
        mode: "LIVE",
      };
      await this.store.save(key, recovered);
      return recovered;
    }
    const response = await this.#call("/pages", "POST", {
      parent: { type: "page_id", page_id: this.parentPageId },
      properties: { title: { type: "title", title: [richText(title)] } },
      children: notes.map(paragraph),
    });
    const id = typeof response["id"] === "string" ? response["id"] : undefined;
    if (!id) throw new ProviderApiError("NOTION", "CREATE_FAILED");
    const resource: ProvisionedResource = {
      externalId: id,
      name: title,
      provider: "NOTION",
      mode: "LIVE",
    };
    await this.store.save(key, resource);
    return resource;
  }

  /**
   * Finds an existing page with this exact title directly under the configured
   * Creator Hub root. Notion's search index is eventually consistent, so this
   * narrows the duplicate window rather than eliminating it; the store lookup
   * above remains the primary guard.
   */
  async #findPage(title: string): Promise<string | undefined> {
    const response = await this.#call("/search", "POST", {
      query: title,
      filter: { value: "page", property: "object" },
      page_size: 50,
    });
    const results = Array.isArray(response["results"]) ? response["results"] : [];
    for (const entry of results) {
      const page = entry as {
        id?: string;
        archived?: boolean;
        parent?: { page_id?: string };
        properties?: { title?: { title?: Array<{ plain_text?: string }> } };
      };
      if (page.archived) continue;
      if (page.parent?.page_id?.replace(/-/g, "") !== this.parentPageId.replace(/-/g, "")) continue;
      const pageTitle = (page.properties?.title?.title ?? [])
        .map((part) => part.plain_text ?? "")
        .join("");
      if (pageTitle === title && typeof page.id === "string") return page.id;
    }
    return undefined;
  }
  async #call(path: string, method: "POST" | "PATCH", body: Record<string, unknown>) {
    const response = await this.request(`https://api.notion.com/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "notion-version": "2026-03-11",
      },
      body: JSON.stringify(body),
    });
    const data = (await response.json()) as Record<string, unknown>;
    if (!response.ok)
      throw new ProviderApiError(
        "NOTION",
        typeof data["code"] === "string" ? data["code"] : `HTTP_${response.status}`,
        typeof data["message"] === "string" ? data["message"] : undefined,
      );
    return data;
  }
}

function normalizeSlackChannel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
}

function richText(content: string) {
  return { type: "text", text: { content } };
}

function paragraph(content: string) {
  return { object: "block", type: "paragraph", paragraph: { rich_text: [richText(content)] } };
}

function mockResource(provider: string, name: string): ProvisionedResource {
  return { externalId: `mock-${provider.toLowerCase()}-${name}`, name, provider, mode: "MOCK" };
}

export class MockSlackProvider implements SlackProvider {
  readonly #resources = new Map<string, ProvisionedResource>();
  createChannel(input: {
    creatorId: string;
    stageSlug: string;
    audience: "creator" | "internal";
    idempotencyKey: string;
  }): Promise<ProvisionedResource> {
    const existing = this.#resources.get(input.idempotencyKey);
    if (existing) return Promise.resolve(existing);
    const resource = mockResource("SLACK", `${input.stageSlug}-${input.audience}`);
    this.#resources.set(input.idempotencyKey, resource);
    return Promise.resolve(resource);
  }
  inviteMembers(): Promise<void> {
    return Promise.resolve();
  }
  setTopic(): Promise<void> {
    return Promise.resolve();
  }
  postMessage(): Promise<void> {
    return Promise.resolve();
  }
  archiveChannel(): Promise<void> {
    return Promise.resolve();
  }
}

export class MockNotionProvider implements NotionProvider {
  readonly #resources = new Map<string, ProvisionedResource>();
  createCreatorHub(input: {
    creatorId: string;
    stageName: string;
    idempotencyKey: string;
  }): Promise<ProvisionedResource> {
    return Promise.resolve(
      this.#getOrCreate(input.idempotencyKey, `${input.stageName}-creator-hub`),
    );
  }
  createInternalResources(input: {
    creatorId: string;
    stageName: string;
    idempotencyKey: string;
  }): Promise<ProvisionedResource> {
    return Promise.resolve(this.#getOrCreate(input.idempotencyKey, `${input.stageName}-internal`));
  }
  updateCreatorHub(): Promise<void> {
    return Promise.resolve();
  }
  archiveCreatorHub(): Promise<void> {
    return Promise.resolve();
  }
  #getOrCreate(key: string, name: string): ProvisionedResource {
    const existing = this.#resources.get(key);
    if (existing) return existing;
    const resource = mockResource("NOTION", name.toLowerCase().replaceAll(" ", "-"));
    this.#resources.set(key, resource);
    return resource;
  }
}

export class MockFileStorageProvider implements FileStorageProvider {
  createCreatorStructure(input: {
    creatorId: string;
    stageSlug: string;
    idempotencyKey: string;
  }): Promise<ProvisionedResource> {
    return Promise.resolve(mockResource("GOOGLE_DRIVE", `${input.stageSlug}-files`));
  }
}

/** Explicit V1 manual boundary: Google/file automation is outside this release. */
export class ManualFileStorageProvider implements FileStorageProvider {
  createCreatorStructure(input: { creatorId: string; stageSlug: string; idempotencyKey: string }) {
    return Promise.resolve({
      externalId: `manual-files-${input.creatorId}`,
      name: `${input.stageSlug}-files-manual-setup`,
      provider: "MANUAL_FILE_STORAGE",
      mode: "PLACEHOLDER" as const,
    });
  }
}

export class OnlyFansProviderPlaceholder implements CreatorRevenueProvider {
  getConnectionHealth(): Promise<{ status: ConnectionStatus; checkedAt: string }> {
    return Promise.resolve({ status: "NOT_CONFIGURED", checkedAt: new Date().toISOString() });
  }
  getDailyRevenue(): Promise<Array<{ date: string; revenue: number | null; source: string }>> {
    return Promise.resolve([]);
  }
}

export class RulesIntelligenceProvider implements IntelligenceProvider {
  readonly name = "RULES";
  enrichDiagnosis(
    input: Readonly<Record<string, unknown>>,
  ): Promise<{ summary: string; suggestions: string[] }> {
    const summary =
      typeof input["summary"] === "string" ? input["summary"] : "Rules diagnosis complete.";
    return Promise.resolve({ summary, suggestions: [] });
  }
}

export class NotConfiguredSlackProvider implements SlackProvider {
  #error(): Error {
    return new Error("SLACK_NOT_CONFIGURED");
  }
  createChannel(): Promise<ProvisionedResource> {
    return Promise.reject(this.#error());
  }
  inviteMembers(): Promise<void> {
    return Promise.reject(this.#error());
  }
  setTopic(): Promise<void> {
    return Promise.reject(this.#error());
  }
  postMessage(): Promise<void> {
    return Promise.reject(this.#error());
  }
  archiveChannel(): Promise<void> {
    return Promise.reject(this.#error());
  }
}
