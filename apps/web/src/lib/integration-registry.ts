import "server-only";
import type { ProviderResourceStore, ProvisionedResource } from "@creatoros/integrations";
import { z } from "zod";
import type { AppSession } from "@/lib/auth";
import { getEnvironment } from "@/lib/environment";
import {
  createOAuthState,
  decryptSecret,
  encryptSecret,
  hashOAuthState,
} from "@/lib/integration-crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type OAuthProvider = "SLACK" | "NOTION";

const idRowSchema = z.object({ id: z.string().uuid() });
const credentialRowSchema = z.object({
  ciphertext: z.string(),
  initialization_vector: z.string(),
  auth_tag: z.string(),
});
const resourceRowSchema = z.object({
  external_id: z.string(),
  display_name: z.string().nullable(),
  provider: z.string(),
});

function requireAdmin() {
  const client = createSupabaseAdminClient();
  if (!client) throw new Error("DATABASE_NOT_CONFIGURED");
  return client;
}

export async function registerOAuthState(
  session: AppSession,
  provider: OAuthProvider,
  redirectUri: string,
) {
  const state = createOAuthState();
  const { error } = await requireAdmin()
    .from("oauth_states")
    .insert({
      organization_id: session.organizationId,
      user_id: session.userId,
      provider,
      state_hash: state.hash,
      redirect_uri: redirectUri,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
  if (error) throw new Error(`OAUTH_STATE_CREATE_FAILED: ${error.message}`);
  return state.value;
}

export async function consumeOAuthState(
  session: AppSession,
  provider: OAuthProvider,
  state: string,
) {
  const result = await requireAdmin().rpc("consume_oauth_state", {
    p_state_hash: hashOAuthState(state),
    p_provider: provider,
    p_user_id: session.userId,
    p_organization_id: session.organizationId,
  });
  const data = z.array(z.object({ redirect_uri: z.string().url() })).safeParse(result.data);
  if (result.error || !data.success || data.data.length !== 1)
    throw new Error("INVALID_OR_EXPIRED_OAUTH_STATE");
  return data.data[0]?.redirect_uri ?? "";
}

export async function saveIntegrationConnection(input: {
  session: AppSession;
  provider: OAuthProvider;
  accessToken: string;
  externalAccountId: string;
  externalWorkspaceName: string | null;
  scopes: string[];
  capabilities: Record<string, unknown>;
}) {
  const admin = requireAdmin();
  const environment = getEnvironment();
  if (!environment.INTEGRATION_ENCRYPTION_KEY)
    throw new Error("INTEGRATION_ENCRYPTION_KEY_REQUIRED");
  const now = new Date().toISOString();
  const existing = await admin
    .from("integration_connections")
    .select("id")
    .eq("organization_id", input.session.organizationId)
    .eq("provider", input.provider)
    .is("creator_id", null)
    .maybeSingle();
  if (existing.error)
    throw new Error(`INTEGRATION_CONNECTION_LOOKUP_FAILED: ${existing.error.message}`);
  const existingConnection = existing.data ? idRowSchema.parse(existing.data) : null;
  const connectionValues = {
    organization_id: input.session.organizationId,
    creator_id: null,
    provider: input.provider,
    category: input.provider === "SLACK" ? "Communication" : "Knowledge",
    status: "CONNECTED",
    environment: environment.APP_ENV,
    external_account_id: input.externalAccountId,
    external_workspace_name: input.externalWorkspaceName,
    scopes: input.scopes,
    capabilities_json: input.capabilities,
    connected_by: input.session.userId,
    connected_at: now,
    last_success_at: now,
    needs_reauthorization: false,
    last_error: null,
    updated_at: now,
  };
  const write = existingConnection
    ? admin
        .from("integration_connections")
        .update(connectionValues)
        .eq("id", existingConnection.id)
        .select("id")
        .single()
    : admin.from("integration_connections").insert(connectionValues).select("id").single();
  const { data: connection, error } = await write;
  if (error || !connection)
    throw new Error(`INTEGRATION_CONNECTION_SAVE_FAILED: ${error?.message ?? "unknown"}`);
  const savedConnection = idRowSchema.parse(connection);
  const encrypted = encryptSecret(input.accessToken, environment.INTEGRATION_ENCRYPTION_KEY);
  const credential = await admin.from("integration_credentials").upsert(
    {
      organization_id: input.session.organizationId,
      integration_connection_id: savedConnection.id,
      provider: input.provider,
      ciphertext: encrypted.ciphertext,
      initialization_vector: encrypted.initializationVector,
      auth_tag: encrypted.authTag,
      updated_at: now,
    },
    { onConflict: "integration_connection_id" },
  );
  if (credential.error) {
    await admin
      .from("integration_connections")
      .update({ status: "ERROR", last_error: "CREDENTIAL_SAVE_FAILED" })
      .eq("id", savedConnection.id);
    throw new Error(`INTEGRATION_CREDENTIAL_SAVE_FAILED: ${credential.error.message}`);
  }
  await appendAudit(
    input.session,
    `${input.provider.toLowerCase()}.connected`,
    "integration_connection",
    savedConnection.id,
    {
      scopes: input.scopes,
      workspace: input.externalWorkspaceName,
    },
  );
  return savedConnection.id;
}

export async function getIntegrationToken(organizationId: string, provider: OAuthProvider) {
  const admin = requireAdmin();
  const { data: connection, error } = await admin
    .from("integration_connections")
    .select("id,status")
    .eq("organization_id", organizationId)
    .eq("provider", provider)
    .is("creator_id", null)
    .maybeSingle();
  const parsedConnection = z
    .object({ id: z.string().uuid(), status: z.string() })
    .safeParse(connection);
  if (error || !parsedConnection.success || parsedConnection.data.status !== "CONNECTED")
    return null;
  const credential = await admin
    .from("integration_credentials")
    .select("ciphertext,initialization_vector,auth_tag")
    .eq("integration_connection_id", parsedConnection.data.id)
    .maybeSingle();
  const key = getEnvironment().INTEGRATION_ENCRYPTION_KEY;
  const parsedCredential = credentialRowSchema.safeParse(credential.data);
  if (credential.error || !parsedCredential.success || !key) return null;
  return {
    connectionId: parsedConnection.data.id,
    token: decryptSecret(
      {
        ciphertext: parsedCredential.data.ciphertext,
        initializationVector: parsedCredential.data.initialization_vector,
        authTag: parsedCredential.data.auth_tag,
      },
      key,
    ),
  };
}

export async function listIntegrationConnections(organizationId: string) {
  const { data, error } = await requireAdmin()
    .from("integration_connections")
    .select(
      "id,provider,status,environment,external_workspace_name,scopes,capabilities_json,configuration_json,last_health_check_at,last_success_at,last_error,needs_reauthorization,connected_at",
    )
    .eq("organization_id", organizationId)
    .is("creator_id", null)
    .order("provider");
  if (error) throw new Error(`INTEGRATION_LIST_FAILED: ${error.message}`);
  return data ?? [];
}

export async function updateIntegrationHealth(
  session: AppSession,
  provider: OAuthProvider,
  result: {
    ok: boolean;
    error?: string | undefined;
    capabilities?: Record<string, unknown> | undefined;
  },
) {
  const now = new Date().toISOString();
  const update = await requireAdmin()
    .from("integration_connections")
    .update({
      status: result.ok ? "CONNECTED" : "DEGRADED",
      health: result.ok ? "HEALTHY" : "UNHEALTHY",
      last_health_check_at: now,
      last_success_at: result.ok ? now : undefined,
      last_error: result.ok ? null : (result.error?.slice(0, 500) ?? "HEALTH_CHECK_FAILED"),
      capabilities_json: result.capabilities ?? undefined,
      needs_reauthorization: result.error === "AUTH_REVOKED",
      updated_at: now,
    })
    .eq("organization_id", session.organizationId)
    .eq("provider", provider)
    .is("creator_id", null);
  if (update.error) throw new Error(`INTEGRATION_HEALTH_SAVE_FAILED: ${update.error.message}`);
}

export async function configureNotionParent(session: AppSession, parentPageId: string) {
  const { error } = await requireAdmin()
    .from("integration_connections")
    .update({ configuration_json: { parentPageId }, updated_at: new Date().toISOString() })
    .eq("organization_id", session.organizationId)
    .eq("provider", "NOTION")
    .is("creator_id", null);
  if (error) throw new Error(`NOTION_CONFIGURATION_SAVE_FAILED: ${error.message}`);
}

export async function disconnectIntegration(session: AppSession, provider: OAuthProvider) {
  const admin = requireAdmin();
  const { data: connection, error } = await admin
    .from("integration_connections")
    .select("id")
    .eq("organization_id", session.organizationId)
    .eq("provider", provider)
    .is("creator_id", null)
    .maybeSingle();
  if (error) throw new Error(`INTEGRATION_LOOKUP_FAILED: ${error.message}`);
  const parsedConnection = idRowSchema.safeParse(connection);
  if (!parsedConnection.success) return;
  await admin
    .from("integration_credentials")
    .delete()
    .eq("integration_connection_id", parsedConnection.data.id);
  const update = await admin
    .from("integration_connections")
    .update({
      status: "DISCONNECTED",
      external_account_id: null,
      external_workspace_name: null,
      scopes: [],
      capabilities_json: {},
      connected_at: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", parsedConnection.data.id);
  if (update.error) throw new Error(`INTEGRATION_DISCONNECT_FAILED: ${update.error.message}`);
  await appendAudit(
    session,
    `${provider.toLowerCase()}.disconnected`,
    "integration_connection",
    parsedConnection.data.id,
    {},
  );
}

async function appendAudit(
  session: AppSession,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: Record<string, unknown>,
) {
  const { error } = await requireAdmin().from("audit_events").insert({
    organization_id: session.organizationId,
    actor_type: "user",
    actor_user_id: session.userId,
    action,
    resource_type: resourceType,
    resource_id: resourceId,
    metadata_json: metadata,
    correlation_id: crypto.randomUUID(),
  });
  if (error) throw new Error(`AUDIT_APPEND_FAILED: ${error.message}`);
}

export class SupabaseProviderResourceStore implements ProviderResourceStore {
  constructor(
    private readonly organizationId: string,
    private readonly creatorId: string,
    private readonly provider: OAuthProvider,
    private readonly resourceType: string,
    private readonly workflowRunId?: string,
  ) {}
  async find(idempotencyKey: string): Promise<ProvisionedResource | null> {
    const { data, error } = await requireAdmin()
      .from("provisioned_resources")
      .select("external_id,display_name,provider")
      .eq("organization_id", this.organizationId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    const parsed = resourceRowSchema.safeParse(data);
    if (error || !parsed.success) return null;
    return {
      externalId: parsed.data.external_id,
      name: parsed.data.display_name ?? parsed.data.external_id,
      provider: parsed.data.provider,
      mode: "LIVE",
    };
  }
  async save(idempotencyKey: string, resource: ProvisionedResource): Promise<void> {
    const { error } = await requireAdmin().from("provisioned_resources").upsert(
      {
        organization_id: this.organizationId,
        creator_id: this.creatorId,
        workflow_run_id: this.workflowRunId,
        provider: this.provider,
        resource_type: this.resourceType,
        external_id: resource.externalId,
        display_name: resource.name,
        environment: getEnvironment().APP_ENV,
        idempotency_key: idempotencyKey,
      },
      { onConflict: "organization_id,idempotency_key" },
    );
    if (error) throw new Error(`PROVIDER_RESOURCE_SAVE_FAILED: ${error.message}`);
  }
}
