import { describe, expect, it } from "vitest";
import type { Role } from "@creatoros/domain";
import { AGENT_TOOLS, executeAgentTool, findTool, type AgentToolContext } from "./tools";

function contextFor(role: Role, creatorFacingSurface = false): AgentToolContext {
  return {
    session: {
      userId: "11111111-1111-4111-8111-111111111111",
      organizationId: "22222222-2222-4222-8222-222222222222",
      role,
    },
    correlationId: "corr-1234",
    creatorFacingSurface,
  };
}

const CREATOR_ID = "33333333-3333-4333-8333-333333333333";

describe("agent tool surface", () => {
  it("exposes only the vetted V1 tools and no escape hatch", () => {
    const names = AGENT_TOOLS.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "acknowledge_alert",
      "create_content_request",
      "create_internal_task",
      "get_creator_experiments",
      "get_creator_integrations",
      "get_creator_metrics",
      "get_creator_reports",
      "get_creator_summary",
      "get_creator_tasks",
      "get_portfolio_alerts",
      "retry_workflow",
      "search_creator",
      "start_creator_activation",
    ]);
    // No arbitrary SQL, HTTP, shell, or credential access is reachable by the model.
    for (const forbidden of ["run_sql", "query", "http_request", "fetch", "get_secret", "execute"])
      expect(findTool(forbidden)).toBeUndefined();
  });

  it("declares a permission and a risk class for every tool", () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool.permission).toBeTruthy();
      expect(["READ", "LOW_RISK_WRITE", "WORKFLOW"]).toContain(tool.risk);
    }
  });

  it("never exposes a tool that can read credentials", () => {
    const source = AGENT_TOOLS.map((tool) => tool.description.toLowerCase()).join(" ");
    expect(source).not.toContain("credential");
    expect(source).not.toContain("token");
  });
});

describe("agent tool authorization", () => {
  it("refuses a tool name the model invented", async () => {
    expect(await executeAgentTool(contextFor("super_admin"), "run_sql", { q: "select 1" })).toEqual(
      {
        ok: false,
        error: "UNKNOWN_TOOL",
      },
    );
  });

  it("denies a write tool to a read-only role", async () => {
    expect(
      await executeAgentTool(contextFor("viewer"), "create_internal_task", { title: "Do a thing" }),
    ).toEqual({ ok: false, error: "PERMISSION_DENIED", permission: "task.create" });
  });

  it("denies integration state to a role without integration.read", async () => {
    // fan_ops holds creator.read and analytics.read but not integration.read.
    expect(
      await executeAgentTool(contextFor("fan_ops"), "get_creator_integrations", {
        creatorId: CREATOR_ID,
      }),
    ).toEqual({ ok: false, error: "PERMISSION_DENIED", permission: "integration.read" });
  });

  it("denies revenue metrics to a role without analytics.read", async () => {
    expect(
      await executeAgentTool(contextFor("contractor"), "get_creator_metrics", {
        creatorId: CREATOR_ID,
      }),
    ).toEqual({ ok: false, error: "PERMISSION_DENIED", permission: "analytics.read" });
  });

  it("blocks internal-only tools in a creator-facing channel even for a super admin", async () => {
    // Authority is not the question here: the risk is disclosure to the creator.
    expect(
      await executeAgentTool(contextFor("super_admin", true), "get_portfolio_alerts", {}),
    ).toEqual({ ok: false, error: "INTERNAL_ONLY_IN_CREATOR_CHANNEL" });
    expect(
      await executeAgentTool(contextFor("super_admin", true), "create_internal_task", {
        title: "Internal follow-up",
      }),
    ).toEqual({ ok: false, error: "INTERNAL_ONLY_IN_CREATOR_CHANNEL" });
    expect(
      await executeAgentTool(contextFor("super_admin", true), "get_creator_integrations", {
        creatorId: CREATOR_ID,
      }),
    ).toEqual({ ok: false, error: "INTERNAL_ONLY_IN_CREATOR_CHANNEL" });
  });

  it("checks permission before the creator-facing surface rule", async () => {
    // A viewer in a creator channel is denied for lacking the permission, which
    // reveals less than naming the channel restriction.
    expect(
      await executeAgentTool(contextFor("viewer", true), "create_internal_task", {
        title: "Internal follow-up",
      }),
    ).toEqual({ ok: false, error: "PERMISSION_DENIED", permission: "task.create" });
  });

  it("rejects malformed tool input before any database access", async () => {
    const result = await executeAgentTool(contextFor("super_admin"), "get_creator_summary", {
      creatorId: "not-a-uuid",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("INVALID_INPUT");
  });

  it("rejects a creator id that is not a uuid on every creator-scoped tool", async () => {
    for (const name of [
      "get_creator_summary",
      "get_creator_metrics",
      "get_creator_tasks",
      "get_creator_reports",
      "get_creator_experiments",
    ]) {
      const result = await executeAgentTool(contextFor("super_admin"), name, {
        creatorId: "'; drop table creators; --",
      });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toBe("INVALID_INPUT");
    }
  });

  it("allows a permitted read for a role that holds the permission", async () => {
    // Reaches execution and fails on the absent database rather than on authorization,
    // which proves the gate passed rather than the tool being unreachable.
    await expect(
      executeAgentTool(contextFor("analyst"), "get_creator_summary", { creatorId: CREATOR_ID }),
    ).rejects.toThrow("DATABASE_NOT_CONFIGURED");
  });
});

/**
 * The workflow tools are the only ones that make CreatorOS act on the outside
 * world on the model's say-so. Everything below is the gate they pass through
 * before that happens; none of it depends on how the model was prompted.
 */
describe("workflow tools", () => {
  const WORKFLOW_TOOLS = ["start_creator_activation", "retry_workflow"];

  it("classifies both as workflow risk and internal only", () => {
    for (const name of WORKFLOW_TOOLS) {
      const tool = findTool(name);
      expect(tool?.risk).toBe("WORKFLOW");
      // Activation state is Foundry's operating business, not the creator's.
      expect(tool?.internalOnly).toBe(true);
    }
  });

  it("denies activation to a role without workflow.start", async () => {
    expect(
      await executeAgentTool(contextFor("growth"), "start_creator_activation", {
        creatorId: CREATOR_ID,
      }),
    ).toEqual({ ok: false, error: "PERMISSION_DENIED", permission: "workflow.start" });
  });

  it("denies resume to a role without workflow.retry", async () => {
    expect(
      await executeAgentTool(contextFor("analyst"), "retry_workflow", { creatorId: CREATOR_ID }),
    ).toEqual({ ok: false, error: "PERMISSION_DENIED", permission: "workflow.retry" });
  });

  it("refuses to run either from a creator-facing channel", async () => {
    for (const name of WORKFLOW_TOOLS)
      expect(
        await executeAgentTool(contextFor("super_admin", true), name, { creatorId: CREATOR_ID }),
      ).toEqual({ ok: false, error: "INTERNAL_ONLY_IN_CREATOR_CHANNEL" });
  });

  it("rejects a malformed creator id before reaching the workflow engine", async () => {
    for (const name of WORKFLOW_TOOLS) {
      const result = await executeAgentTool(contextFor("super_admin"), name, {
        creatorId: "madison",
      });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toBe("INVALID_INPUT");
    }
  });

  it("never claims a creator is activated, only that work was queued", () => {
    // A model that reads "activated" in a tool description will report it that
    // way in Slack, and the workflow can still block or park on a prerequisite.
    for (const name of WORKFLOW_TOOLS) {
      const description = findTool(name)?.description.toLowerCase() ?? "";
      expect(description).toContain("queue");
      expect(description).not.toContain("activates the creator");
    }
  });
});
