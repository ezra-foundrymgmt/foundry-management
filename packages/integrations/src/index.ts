import { assertProjectableFields } from "./projection";
export * from "./projection";
import { createHash } from "node:crypto";
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
  /**
   * Invites someone who is NOT a member of the workspace, by email, over Slack
   * Connect.
   *
   * Separate from `inviteMembers` because a creator is not a colleague:
   * `conversations.invite` takes workspace user ids and simply cannot reach
   * them. It also resolves differently — the invite is an offer the creator
   * accepts in their own Slack, so success here means "asked", not "joined".
   *
   * Returns a result rather than throwing, because Slack Connect depends on
   * workspace plan and admin policy. An agency whose plan does not allow it
   * still wants the rest of activation to complete, with this one step left
   * visibly outstanding rather than the whole creator failing to onboard.
   */
  inviteExternalByEmail(
    resourceId: string,
    email: string,
  ): Promise<{ invited: boolean; reason?: string }>;
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

interface NotionPageResponse {
  id?: string;
  code?: string;
  archived?: boolean;
  in_trash?: boolean;
  properties?: Record<
    string,
    { type?: string; title?: Array<{ plain_text?: string }> } | undefined
  >;
}

interface SlackUserInfoResponse {
  ok: boolean;
  error?: string;
  user?: {
    id?: string;
    team_id?: string;
    name?: string;
    deleted?: boolean;
    is_bot?: boolean;
    profile?: { display_name?: string; real_name?: string };
  };
}

interface SlackResponse {
  ok: boolean;
  error?: string;
  channel?: { id?: string; name?: string; is_private?: boolean };
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
    const name = composeChannelName(
      input.audience === "creator" ? "creator" : "internal",
      input.stageSlug,
      input.creatorId,
    );
    const created = await this.#call("conversations.create", { name, is_private: true });
    let externalId = created.channel?.id;
    if (!created.ok && created.error === "name_taken") externalId = await this.#findChannel(name);
    if (!externalId) throw new ProviderApiError("SLACK", created.error ?? "CREATE_FAILED");
    // A name_taken reconcile recovers a channel this code did not create in this
    // run. Adopting it blindly would bind a creator channel to whatever already
    // held the name — including a public channel, which would publish creator
    // material to the whole workspace.
    if (!created.ok) await this.#assertPrivateChannel(externalId);
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
  async inviteExternalByEmail(
    resourceId: string,
    email: string,
  ): Promise<{ invited: boolean; reason?: string }> {
    const response = await this.#call("conversations.inviteShared", {
      channel: resourceId,
      emails: [email],
    });
    if (response.ok) return { invited: true };
    /**
     * Already invited or already present is success, not failure — activation
     * is re-runnable and must not report a step failed because it had already
     * done its job.
     */
    const reason = response.error ?? "INVITE_SHARED_FAILED";
    if (reason === "already_invited" || reason === "already_in_channel") return { invited: true };
    return { invited: false, reason };
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
  async #assertPrivateChannel(channelId: string): Promise<void> {
    const info = await this.#call("conversations.info", { channel: channelId });
    if (!info.ok) throw new ProviderApiError("SLACK", info.error ?? "CHANNEL_INFO_FAILED");
    if (info.channel?.is_private !== true)
      throw new ProviderApiError(
        "SLACK",
        "RECONCILED_CHANNEL_NOT_PRIVATE",
        `refusing to bind a creator channel to public channel ${channelId}`,
      );
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
    // let a retry create "Madison Hub 2". Reconciling first closes that window,
    // mirroring the Slack name_taken path.
    //
    // The match is on the provisioning marker, NOT the title. Titles are derived
    // from the stage name, and two creators can share a stage name — matching on
    // title would bind the second creator to the first creator's hub, which for
    // a creator-readable page means showing one creator another's material.
    const reconciled = await this.#findPage(title, key);
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
      children: [...notes.map(paragraph), paragraph(provisioningMarker(key))],
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
   * Finds a page this code previously created for exactly this provisioning key,
   * directly under the configured Creator Hub root.
   *
   * A candidate must match the title *and* carry the provisioning marker for
   * this key. Title alone is not identity: two creators can share a stage name,
   * and adopting a namesake's page would show one creator another's material.
   *
   * Notion's search index is eventually consistent, so this narrows the
   * duplicate window rather than eliminating it; the store lookup remains the
   * primary guard.
   */
  async #findPage(title: string, key: string): Promise<string | undefined> {
    const marker = provisioningMarker(key);
    let cursor: string | undefined;
    // Search is workspace-wide full text, so a busy workspace pushes the page we
    // want past the first result page. Paginate, bounded.
    for (let page = 0; page < 10; page += 1) {
      const response = await this.#call("/search", "POST", {
        query: title,
        filter: { value: "page", property: "object" },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      const results = Array.isArray(response["results"]) ? response["results"] : [];
      for (const entry of results) {
        const candidate = entry as {
          id?: string;
          archived?: boolean;
          parent?: { page_id?: string };
          properties?: { title?: { title?: Array<{ plain_text?: string }> } };
        };
        if (candidate.archived || typeof candidate.id !== "string") continue;
        if (candidate.parent?.page_id?.replace(/-/g, "") !== this.parentPageId.replace(/-/g, ""))
          continue;
        const pageTitle = (candidate.properties?.title?.title ?? [])
          .map((part) => part.plain_text ?? "")
          .join("");
        if (pageTitle !== title) continue;
        if (await this.#hasMarker(candidate.id, marker)) return candidate.id;
      }
      const hasMore = response["has_more"] === true;
      const next = response["next_cursor"];
      if (!hasMore || typeof next !== "string") return undefined;
      cursor = next;
    }
    return undefined;
  }

  /** Confirms a candidate page carries this provisioning key's marker block. */
  async #hasMarker(pageId: string, marker: string): Promise<boolean> {
    const response = await this.#call(`/blocks/${pageId}/children?page_size=100`, "GET", {});
    const results = Array.isArray(response["results"]) ? response["results"] : [];
    return results.some((entry) => {
      const block = entry as {
        paragraph?: { rich_text?: Array<{ plain_text?: string }> };
      };
      return (block.paragraph?.rich_text ?? []).some((part) =>
        (part.plain_text ?? "").includes(marker),
      );
    });
  }
  async #call(path: string, method: "GET" | "POST" | "PATCH", body: Record<string, unknown>) {
    const response = await this.request(`https://api.notion.com/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "notion-version": "2026-03-11",
      },
      // fetch rejects a GET carrying a body.
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
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

/** Slack's hard limit on a channel name. */
const SLACK_CHANNEL_NAME_LIMIT = 80;

/**
 * The identity stamp written into every page this code provisions.
 *
 * Reconciling an orphaned page needs to prove the candidate is *this* creator's
 * page. A title cannot prove that — two creators can share a stage name — so
 * creation writes this marker and reconcile requires it.
 */
export function provisioningMarker(idempotencyKey: string): string {
  return `creatoros-provisioning-key:${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 24)}`;
}

/**
 * A stable, non-empty discriminator derived from the whole creator id.
 *
 * A tail slice of the id was not good enough: it folds case (so two ids
 * differing only in case collide) and produces an empty string for any id with
 * no alphanumerics, which would silently drop the discriminator entirely. A
 * hash always yields a fixed-width value and uses the whole id.
 */
export function creatorDiscriminator(creatorId: string): string {
  return createHash("sha256").update(creatorId).digest("hex").slice(0, 8);
}

/**
 * Composes a channel name that keeps its discriminator.
 *
 * The discriminator is the trailing component, so truncating the *composed*
 * name to Slack's 80-character limit removes it first — which reintroduces
 * exactly the cross-creator collision the discriminator exists to prevent. The
 * slug is truncated instead, and the discriminator's width is reserved.
 */
export function composeChannelName(
  audience: "creator" | "internal",
  stageSlug: string,
  creatorId: string,
): string {
  const discriminator = creatorDiscriminator(creatorId);
  const prefix = audience;
  const budget = SLACK_CHANNEL_NAME_LIMIT - prefix.length - discriminator.length - 2;
  const slug = normalizeSlackChannel(stageSlug).slice(0, Math.max(budget, 1));
  const name = normalizeSlackChannel(`${prefix}-${slug}-${discriminator}`);
  // Composition must never be able to eat the discriminator.
  if (!name.endsWith(discriminator))
    throw new ProviderApiError("SLACK", "CHANNEL_NAME_DISCRIMINATOR_LOST", name);
  return name;
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
  readonly invited = new Map<string, string[]>();
  readonly externalInvites = new Map<string, string[]>();
  inviteMembers(resourceId: string, memberIds: string[]): Promise<void> {
    this.invited.set(resourceId, [...(this.invited.get(resourceId) ?? []), ...memberIds]);
    return Promise.resolve();
  }
  inviteExternalByEmail(resourceId: string, email: string): Promise<{ invited: boolean }> {
    this.externalInvites.set(resourceId, [
      ...(this.externalInvites.get(resourceId) ?? []),
      email,
    ]);
    return Promise.resolve({ invited: true });
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
  inviteExternalByEmail(): Promise<{ invited: boolean; reason?: string }> {
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

export interface SlackUserSummary {
  slackUserId: string;
  slackTeamId: string;
  displayName: string;
}

/**
 * Confirms a Slack account exists in the workspace before anyone is allowed to
 * link it to a CreatorOS identity.
 *
 * A mapping is an authorization grant: whoever holds that Slack account gets to
 * ask the Foundry agent questions as the CreatorOS user it points at. A typo in
 * a Slack ID would otherwise create a live grant addressed to nobody, waiting
 * for Slack to assign that ID to someone.
 *
 * Deleted accounts and bots return null. A bot carrying a founder's permissions
 * is not an identity anyone decided to grant.
 */
export async function lookupSlackUser(
  token: string,
  slackUserId: string,
  request: FetchLike = fetch,
): Promise<SlackUserSummary | null> {
  const response = await request(
    `https://slack.com/api/users.info?user=${encodeURIComponent(slackUserId)}`,
    { method: "GET", headers: { authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw new ProviderApiError("SLACK", `HTTP_${response.status}`);
  const body = (await response.json()) as SlackUserInfoResponse;
  // user_not_found is the answer to the question, not a failure to answer it.
  if (!body.ok) {
    if (body.error === "user_not_found") return null;
    throw new ProviderApiError("SLACK", body.error ?? "USER_LOOKUP_FAILED");
  }
  const user = body.user;
  if (!user?.id || !user.team_id) return null;
  if (user.deleted === true || user.is_bot === true) return null;
  return {
    slackUserId: user.id,
    slackTeamId: user.team_id,
    displayName:
      user.profile?.display_name?.trim() ||
      user.profile?.real_name?.trim() ||
      user.name?.trim() ||
      user.id,
  };
}

export interface NotionPageSummary {
  pageId: string;
  title: string;
  archived: boolean;
}

/**
 * Confirms the Creator Hub root page exists and this integration can reach it.
 *
 * Every creator hub CreatorOS ever creates is a child of this page, so an
 * unverified ID is how creator material ends up written into an arbitrary
 * page — one shared with the wrong people, or belonging to somebody else
 * entirely. Notion answers 404 both for a page that does not exist and for one
 * the integration was never granted, which is exactly the distinction that must
 * not be guessed at.
 *
 * Returns null when the page is unreachable. An archived page is returned rather
 * than hidden: the caller decides, and a silent null would read as "no such
 * page" when the truth is "you need to unarchive it".
 */
export async function lookupNotionPage(
  token: string,
  pageId: string,
  request: FetchLike = fetch,
): Promise<NotionPageSummary | null> {
  const response = await request(`https://api.notion.com/v1/pages/${encodeURIComponent(pageId)}`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "notion-version": "2026-03-11",
    },
  });
  if (response.status === 404 || response.status === 403) return null;
  const data = (await response.json()) as NotionPageResponse;
  if (!response.ok)
    throw new ProviderApiError(
      "NOTION",
      typeof data.code === "string" ? data.code : `HTTP_${response.status}`,
    );
  if (!data.id) return null;
  return {
    pageId: data.id,
    title: notionPageTitle(data) ?? "Untitled",
    archived: data.archived === true || data.in_trash === true,
  };
}

/**
 * Notion puts a page's title under whichever property is of type `title`, whose
 * name varies by database and is absent on a workspace page, so it has to be
 * found by type rather than looked up by a fixed key.
 */
function notionPageTitle(page: NotionPageResponse): string | null {
  for (const property of Object.values(page.properties ?? {})) {
    if (property?.type !== "title") continue;
    const text = (property.title ?? [])
      .map((fragment) => fragment.plain_text ?? "")
      .join("")
      .trim();
    if (text) return text;
  }
  return null;
}
