import { describe, expect, it } from "vitest";
import { normalizeAgentTools } from "../tool/executable-as-tool";
import { ragAsTool } from "./as-tool";
import type { RetrieveResult } from "./contracts/citation.type";

function fakeRetrieve(query: string): Promise<RetrieveResult> {
  return Promise.resolve({
    query,
    chunks: [
      {
        text: "hit text",
        score: 0.9,
        citation: { sourceId: "doc", chunkIndex: 0, span: [0, 8], score: 0.9 },
      },
    ],
  });
}

describe("ragAsTool", () => {
  it("produces a ToolContract with an invoke method", () => {
    const tool = ragAsTool("docs", fakeRetrieve);

    expect(typeof tool.invoke).toBe("function");
    expect(tool.name).toBe("retrieve_docs");
  });

  it("invoke({ query }) returns the RetrieveResult as data", async () => {
    const tool = ragAsTool("docs", fakeRetrieve);

    const result = await tool.invoke({ query: "find me docs" });

    expect(result.error).toBeUndefined();
    expect(result.data?.query).toBe("find me docs");
    expect(result.data?.chunks).toHaveLength(1);
  });

  it("passes through normalizeAgentTools untouched (has invoke)", () => {
    const tool = ragAsTool("docs", fakeRetrieve);

    // `AgentToolEntry` is invariant in its input; a concrete `{ query }`
    // tool is widened to the runtime's `unknown` entry type, exactly as
    // the agent does internally when collecting `tools: []`.
    const normalized = normalizeAgentTools([tool as never]);

    expect(normalized).toHaveLength(1);
    expect(normalized?.[0]).toBe(tool);
  });

  it("honors a custom tool name and description", () => {
    const tool = ragAsTool("docs", fakeRetrieve, {
      name: "search_kb",
      description: "Search the product docs.",
    });

    expect(tool.name).toBe("search_kb");
    expect(tool.description).toBe("Search the product docs.");
  });

  it("serializes a retrieve() error as ToolExecutionError, never throws", async () => {
    const tool = ragAsTool("docs", () => Promise.reject(new Error("store down")));

    const result = await tool.invoke({ query: "anything" });

    expect(result.data).toBeUndefined();
    expect(result.error?.name).toBe("ToolExecutionError");
  });

  it("rejects input that is not { query: string } with a SchemaValidationError", async () => {
    const tool = ragAsTool("docs", fakeRetrieve);

    const result = await tool.invoke({ notQuery: 123 });

    expect(result.data).toBeUndefined();
    expect(result.error?.name).toBe("SchemaValidationError");
  });
});
