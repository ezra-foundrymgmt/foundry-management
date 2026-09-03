import "server-only";
import { z } from "zod";
import { isMockMode } from "@/lib/environment";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const mockConversions = new Map<string, string>();

export async function convertProspect(input: {
  prospectId: string;
  organizationId: string;
  actorUserId: string;
}) {
  // Through the contract, not a raw read. The raw read defaulted to mock, and
  // the mock branch answers with a creator that was never written — a fabricated
  // 200 in any deployed environment where the variable did not arrive.
  if (isMockMode()) {
    if (input.prospectId !== "jessica") throw new ConversionError("PROSPECT_NOT_FOUND", 404);
    const existing = mockConversions.get(input.prospectId);
    if (existing) return { creatorId: existing, created: false, mode: "MOCK" as const };
    const creatorId = "creator-from-jessica";
    mockConversions.set(input.prospectId, creatorId);
    return { creatorId, created: true, mode: "MOCK" as const };
  }

  const client = createSupabaseAdminClient();
  if (!client) throw new ConversionError("DATABASE_NOT_CONFIGURED", 503);
  const { data: prospect, error: lookupError } = await client
    .from("prospects")
    .select("id,organization_id")
    .eq("id", input.prospectId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (lookupError) throw new Error(lookupError.message);
  if (!prospect) throw new ConversionError("PROSPECT_NOT_FOUND", 404);

  const rpcResponse = await client.rpc("convert_prospect_to_creator", {
    p_prospect_id: input.prospectId,
    p_actor_id: input.actorUserId,
  });
  if (rpcResponse.error) throw new Error(rpcResponse.error.message);
  const creatorId = z.string().uuid().parse(rpcResponse.data);
  return { creatorId, created: true, mode: "LIVE" as const };
}

export class ConversionError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 503,
  ) {
    super(message);
  }
}
