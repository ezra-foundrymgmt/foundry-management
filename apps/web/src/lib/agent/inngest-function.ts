import { NonRetriableError } from "inngest";
import { z } from "zod";
import type { Role } from "@creatoros/domain";
import { inngest } from "@/lib/inngest";
import { logEvent } from "@/lib/observability";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getIntegrationToken } from "@/lib/integration-registry";
import { resolveSlackIdentity } from "@/lib/slack-events";
import { runFoundryAgent } from "@/lib/agent/runtime";
import { isCreatorFacingChannel, postSlackReply } from "@/lib/agent/slack-reply";

const agentEventSchema = z.object({
  organizationId: z.string().uuid(),
  slackTeamId: z.string().min(1),
  slackEventId: z.string().min(1),
  slackUserId: z.string().min(1),
  channelId: z.string().min(1),
  isDirectMessage: z.boolean().optional(),
  threadTs: z.string().nullable().optional(),
  prompt: z.string().min(1).max(4000),
  correlationId: z.string().min(1),
});

const membershipSchema = z.object({
  role: z.string(),
  active: z.boolean(),
});
const userSchema = z.object({ email: z.string() });

function admin() {
  const client = createSupabaseAdminClient();
  if (!client) throw new NonRetriableError("DATABASE_NOT_CONFIGURED");
  return client;
}

/**
 * Runs one Foundry agent turn for a Slack message.
 *
 * Split from the HTTP handler because Slack demands a response in three seconds
 * and a model turn with tool calls takes far longer. The ingress verifies,
 * deduplicates and enqueues; this does the work and posts the answer back.
 */
export const respondToSlackMention = inngest.createFunction(
  {
    id: "foundry-agent-slack-respond",
    retries: 2,
    // One answer per Slack event, even if the event is enqueued twice.
    idempotency: "event.data.slackEventId",
    triggers: [{ event: "slack.agent.requested" }],
  },
  async ({ event, step }) => {
    const parsed = agentEventSchema.safeParse(event.data);
    if (!parsed.success) throw new NonRetriableError("INVALID_AGENT_EVENT");
    const input = parsed.data;

    // Slack membership is not CreatorOS authorization. An unmapped Slack user
    // gets a refusal, never a default identity.
    const session = await step.run("resolve-creatoros-identity", async () => {
      const identity = await resolveSlackIdentity({
        slackTeamId: input.slackTeamId,
        slackUserId: input.slackUserId,
        organizationId: input.organizationId,
      });
      if (!identity) return null;
      const client = admin();
      const [membership, user] = await Promise.all([
        client
          .from("organization_memberships")
          .select("role,active")
          .eq("organization_id", input.organizationId)
          .eq("user_id", identity.userId)
          .eq("active", true)
          .maybeSingle(),
        client.from("users").select("email").eq("id", identity.userId).maybeSingle(),
      ]);
      const parsedMembership = membershipSchema.safeParse(membership.data);
      const parsedUser = userSchema.safeParse(user.data);
      if (!parsedMembership.success || !parsedMembership.data.active || !parsedUser.success)
        return null;
      // The email is looked up here to prove the account exists, then dropped.
      // A step's return value is persisted in Inngest Cloud run state, so
      // returning it would copy a Foundry employee's address out of the database
      // into a third-party workflow store on every @-mention. Same reasoning as
      // the bot token below; it is re-read where it is actually used.
      return {
        userId: identity.userId,
        organizationId: input.organizationId,
        role: parsedMembership.data.role as Role,
      };
    });

    // Deliberately NOT inside step.run: Inngest persists a step's return value
    // in its own run state, so returning the decrypted bot token from a step
    // would copy a live credential out of the database and into Inngest Cloud.
    // It is re-read from Supabase on each attempt instead.
    const loadSlackToken = async () => {
      const token = await getIntegrationToken(input.organizationId, "SLACK");
      if (!token) throw new NonRetriableError("SLACK_INTEGRATION_NOT_CONNECTED");
      return token.token;
    };

    if (!session) {
      logEvent("warn", "agent.unmapped_slack_user", {
        correlationId: input.correlationId,
        organizationId: input.organizationId,
        slackUserId: input.slackUserId,
      });
      await step.run("reply-unmapped-user", async () =>
        postSlackReply({
          token: await loadSlackToken(),
          channel: input.channelId,
          threadTs: input.threadTs ?? null,
          // Says nothing about what exists; only that this Slack account is not linked.
          text: "I can't answer that: your Slack account isn't linked to a CreatorOS user. A Foundry admin can link it in CreatorOS settings.",
        }),
      );
      return { status: "UNMAPPED_SLACK_USER" };
    }

    const interactionId = await step.run("record-agent-interaction", async () => {
      const creatorFacing = await isCreatorFacingChannel(input.organizationId, input.channelId, {
        isDirectMessage: input.isDirectMessage ?? false,
      });
      const { data, error } = await admin()
        .from("agent_interactions")
        .insert({
          organization_id: input.organizationId,
          user_id: session.userId,
          surface: "SLACK",
          slack_team_id: input.slackTeamId,
          slack_channel_id: input.channelId,
          slack_user_id: input.slackUserId,
          slack_thread_ts: input.threadTs ?? null,
          prompt: input.prompt,
          status: "RUNNING",
        })
        .select("id")
        .single();
      if (error) throw new Error(`AGENT_INTERACTION_INSERT_FAILED: ${error.message}`);
      return { id: z.object({ id: z.string().uuid() }).parse(data).id, creatorFacing };
    });

    const outcome = await step.run("run-foundry-agent", async () => {
      try {
        const result = await runFoundryAgent({
          session,
          prompt: input.prompt,
          correlationId: input.correlationId,
          surface: { creatorFacing: interactionId.creatorFacing, channelId: input.channelId },
        });
        await admin()
          .from("agent_interactions")
          .update({
            response: result.reply,
            tool_calls_json: result.toolCalls,
            model: result.model,
            status: "SUCCEEDED",
            completed_at: new Date().toISOString(),
          })
          .eq("id", interactionId.id);
        return { reply: result.reply, toolCount: result.toolCalls.length };
      } catch (error) {
        const message = error instanceof Error ? error.message : "AGENT_FAILED";
        await admin()
          .from("agent_interactions")
          .update({
            status: "FAILED",
            error_message: message,
            completed_at: new Date().toISOString(),
          })
          .eq("id", interactionId.id);
        throw error;
      }
    });

    await step.run("post-slack-reply", async () =>
      postSlackReply({
        token: await loadSlackToken(),
        channel: input.channelId,
        threadTs: input.threadTs ?? null,
        text: outcome.reply,
      }),
    );

    logEvent("info", "agent.replied", {
      correlationId: input.correlationId,
      organizationId: input.organizationId,
      interactionId: interactionId.id,
      toolCount: outcome.toolCount,
    });
    return { status: "REPLIED", interactionId: interactionId.id };
  },
);
