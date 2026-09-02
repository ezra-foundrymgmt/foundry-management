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
