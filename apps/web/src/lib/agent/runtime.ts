import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { getEnvironment } from "@/lib/environment";
import { logEvent } from "@/lib/observability";
import { buildSystemPrompt, type PromptSurface } from "@/lib/agent/prompt";
import {
  AGENT_TOOLS,
  executeAgentTool,
  type AgentIdentity,
  type AgentToolContext,
} from "@/lib/agent/tools";

/** Slack replies are read on a phone; long answers are a bug, not a feature. */
const MAX_TOKENS = 4096;

/**
 * Bounds the tool loop. A model that keeps calling tools without concluding is
 * a runaway cost and latency problem, so the loop stops and reports rather than
 * running forever.
 */
const MAX_TURNS = 8;

export interface AgentToolCallRecord {
  name: string;
  input: unknown;
  ok: boolean;
  error?: string;
}

export interface AgentRunResult {
  reply: string;
  toolCalls: AgentToolCallRecord[];
  model: string;
  stopReason: string | null;
}

function toolDefinitions(): Anthropic.Tool[] {
  return AGENT_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Anthropic.Tool.InputSchema,
  }));
}

export async function runFoundryAgent(input: {
  session: AgentIdentity;
  prompt: string;
  correlationId: string;
  surface: PromptSurface;
}): Promise<AgentRunResult> {
  const environment = getEnvironment();
  if (!environment.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY_NOT_CONFIGURED");
  const client = new Anthropic({ apiKey: environment.ANTHROPIC_API_KEY });
  const model = environment.FOUNDRY_AGENT_MODEL;

  const context: AgentToolContext = {
    session: input.session,
    correlationId: input.correlationId,
    creatorFacingSurface: input.surface.creatorFacing,
  };

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: input.prompt }];
  const toolCalls: AgentToolCallRecord[] = [];
  let stopReason: string | null = null;

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const response = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      system: buildSystemPrompt(input.session, input.surface),
      tools: toolDefinitions(),
      messages,
    });
    stopReason = response.stop_reason;

    if (response.stop_reason === "refusal") {
      return {
        reply:
          "I can't answer that one. If you think that's wrong, rephrase it or ask a Foundry admin.",
        toolCalls,
        model,
        stopReason,
      };
    }

    if (response.stop_reason !== "tool_use") {
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      return { reply: text || "I don't have an answer for that.", toolCalls, model, stopReason };
    }

    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );

    // All tool results for one assistant turn go back in a single user message;
    // splitting them across messages trains the model out of parallel calls.
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      let record: AgentToolCallRecord = { name: toolUse.name, input: toolUse.input, ok: false };
      let payload: string;
      try {
        const outcome = await executeAgentTool(context, toolUse.name, toolUse.input);
        if (outcome.ok) {
          record = { ...record, ok: true };
          payload = JSON.stringify(outcome.data);
        } else {
          record = { ...record, ok: false, error: outcome.error };
          payload = JSON.stringify(outcome);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "TOOL_EXECUTION_FAILED";
        record = { ...record, ok: false, error: message };
        payload = JSON.stringify({ ok: false, error: message });
      }
      toolCalls.push(record);
      logEvent("info", "agent.tool_call", {
        correlationId: input.correlationId,
        organizationId: input.session.organizationId,
        tool: toolUse.name,
        ok: record.ok,
        error: record.error,
      });
      results.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: payload,
        is_error: !record.ok,
      });
    }
    messages.push({ role: "user", content: results });
  }

  return {
    reply:
      "I looked into that but couldn't finish within my step limit. Try narrowing the question to one creator or one metric.",
    toolCalls,
    model,
    stopReason,
  };
}
