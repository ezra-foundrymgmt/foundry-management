"use client";

import { useEffect } from "react";

interface BrowserTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute(input: unknown): Promise<unknown>;
}

declare global {
  interface Document {
    readonly modelContext?: {
      registerTool(tool: BrowserTool, options?: { signal?: AbortSignal }): void | Promise<void>;
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function WebMcpTools() {
  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();

    const reportError = (error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (process.env.NODE_ENV === "development")
        console.error("WebMCP registration failed", error);
    };

    const searchTool: BrowserTool = {
      name: "search_creatoros",
      title: "Search CreatorOS",
      description: "Search tenant-scoped creator, prospect, and task records by name or title.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", minLength: 1, maxLength: 80 } },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      async execute(input) {
        if (!isRecord(input) || typeof input["query"] !== "string" || input["query"].length > 80) {
          throw new TypeError("query must be a string between 1 and 80 characters");
        }
        const response = await fetch(`/api/search?q=${encodeURIComponent(input["query"])}`);
        if (!response.ok) throw new Error("CreatorOS search failed");
        return response.json() as Promise<unknown>;
      },
    };

    const openCreatorTool: BrowserTool = {
      name: "open_creator_record",
      title: "Open creator record",
      description:
        "Navigate to a Creator 360 record after its stable creator ID has been selected.",
      inputSchema: {
        type: "object",
        properties: { creatorId: { type: "string", pattern: "^[a-z0-9-]+$" } },
        required: ["creatorId"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute(input) {
        if (
          !isRecord(input) ||
          typeof input["creatorId"] !== "string" ||
          !/^[a-z0-9-]+$/.test(input["creatorId"])
        ) {
          throw new TypeError("creatorId must be a stable CreatorOS identifier");
        }
        window.location.assign(`/creators/${input["creatorId"]}`);
        return Promise.resolve({ status: "navigating", creatorId: input["creatorId"] });
      },
    };

    try {
      void Promise.all([
        Promise.resolve(context.registerTool(searchTool, { signal: lifecycle.signal })),
        Promise.resolve(context.registerTool(openCreatorTool, { signal: lifecycle.signal })),
      ]).catch(reportError);
    } catch (error) {
      reportError(error);
    }

    return () => lifecycle.abort();
  }, []);

  return null;
}
