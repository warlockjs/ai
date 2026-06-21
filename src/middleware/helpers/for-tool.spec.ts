import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it, vi } from "vitest";
import { agent } from "../../agent/agent";
import type { AgentMiddleware } from "../../contracts/middleware";
import { MockSDK } from "../../mock/mock-sdk";
import { tool } from "../../tool/tool";
import { forTool } from "./for-tool";

const emptyInputSchema: StandardSchemaV1<Record<string, unknown>> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: value => ({ value: (value ?? {}) as Record<string, unknown> }),
  },
};

function makeObservingMiddleware(
  name: string,
  observer: { names: string[] },
): AgentMiddleware {
  return {
    name,
    tool: {
      before(ctx) {
        observer.names.push(ctx.tool.name);
      },
    },
  };
}

describe("forTool", () => {
  it("invokes the wrapped tool-hooks only for matching tool names", async () => {
    const alphaTool = tool({
      name: "alpha",
      description: "alpha",
      input: emptyInputSchema,
      execute: async () => ({ ok: true }),
    });
    const betaTool = tool({
      name: "beta",
      description: "beta",
      input: emptyInputSchema,
      execute: async () => ({ ok: true }),
    });

    const observer = { names: [] as string[] };
    const inner = makeObservingMiddleware("observer", observer);
    const scoped = forTool("alpha", inner);

    const sdk = MockSDK({
      responses: [
        {
          content: "calling tools",
          finishReason: "tool_calls",
          toolCalls: [
            { id: "1", name: "alpha", input: {} },
            { id: "2", name: "beta", input: {} },
          ],
        },
        { content: "done", finishReason: "stop" },
      ],
    });

    const ai = agent({
      model: sdk.model({ name: "m" }),
      tools: [alphaTool, betaTool],
      middleware: [scoped],
    });

    await ai.execute("hi");

    expect(observer.names).toEqual(["alpha"]);
  });

  it("accepts an array of names", async () => {
    const t1 = tool({
      name: "t1",
      description: "",
      input: emptyInputSchema,
      execute: async () => ({}),
    });
    const t2 = tool({
      name: "t2",
      description: "",
      input: emptyInputSchema,
      execute: async () => ({}),
    });
    const t3 = tool({
      name: "t3",
      description: "",
      input: emptyInputSchema,
      execute: async () => ({}),
    });

    const observer = { names: [] as string[] };
    const scoped = forTool(
      ["t1", "t3"],
      makeObservingMiddleware("obs", observer),
    );

    const sdk = MockSDK({
      responses: [
        {
          content: "tools",
          finishReason: "tool_calls",
          toolCalls: [
            { id: "1", name: "t1", input: {} },
            { id: "2", name: "t2", input: {} },
            { id: "3", name: "t3", input: {} },
          ],
        },
        { content: "done", finishReason: "stop" },
      ],
    });

    await agent({
      model: sdk.model({ name: "m" }),
      tools: [t1, t2, t3],
      middleware: [scoped],
    }).execute("hi");

    expect(observer.names).toEqual(["t1", "t3"]);
  });

  it("returns middleware unchanged when it has no tool hooks", () => {
    const base: AgentMiddleware = {
      name: "no-tool-hooks",
      execute: { before: vi.fn() },
    };

    const out = forTool("anything", base);

    expect(out).toBe(base);
  });

  it("passes execute and trip hooks through unchanged", () => {
    const before = vi.fn();
    const base: AgentMiddleware = {
      name: "mixed",
      execute: { before },
      tool: { before: vi.fn() },
    };

    const out = forTool("alpha", base);

    expect(out.execute?.before).toBe(before);
    expect(out.name).toMatch(/^mixed\[for:alpha\]$/);
  });
});
