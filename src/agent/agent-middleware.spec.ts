import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import type { AgentMiddleware } from "../contracts/middleware";
import { AgentExecutionError, AIError, BudgetExceededError } from "../errors";
import { MockSDK } from "../mock/mock-sdk";
import { tool } from "../tool/tool";
import { agent } from "./agent";

const emptyInput: StandardSchemaV1<Record<string, unknown>> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: value => ({ value: (value ?? {}) as Record<string, unknown> }),
  },
};

describe("agent + middleware — execute-level", () => {
  it("execute.before throw lands on result.error; agent does not throw", async () => {
    const sdk = MockSDK({
      responses: [{ content: "never", finishReason: "stop" }],
    });

    const denier: AgentMiddleware = {
      name: "deny",
      execute: {
        before() {
          throw new BudgetExceededError("pre-flight budget check", {
            limit: 0,
            actual: 100,
            unit: "tokens",
          });
        },
      },
    };

    const ai = agent({
      model: sdk.model({ name: "m" }),
      middleware: [denier],
    });

    const result = await ai.execute("hi");

    expect(result.error).toBeInstanceOf(BudgetExceededError);
    expect(result.report.trips).toHaveLength(0);
    expect(sdk.models[0].callCount).toBe(0);
  });

  it("execute.after can transform the result without touching runCore state", async () => {
    const sdk = MockSDK({
      responses: [{ content: "original", finishReason: "stop" }],
    });

    const transformer: AgentMiddleware = {
      name: "wrap",
      execute: {
        after(_ctx, result) {
          return {
            ...result,
            text: `[wrapped] ${result.text}`,
          };
        },
      },
    };

    const ai = agent({
      model: sdk.model({ name: "m" }),
      middleware: [transformer],
    });

    const result = await ai.execute("hi");

    expect(result.text).toBe("[wrapped] original");
    expect(result.error).toBeUndefined();
  });
});

describe("agent + middleware — trip-level short-circuit", () => {
  it("trip.before synthetic ModelResponse skips the real model call", async () => {
    const sdk = MockSDK({
      responses: [{ content: "real-answer", finishReason: "stop" }],
    });

    const shortCircuit: AgentMiddleware = {
      name: "cache-like",
      trip: {
        before() {
          return {
            content: "cached-answer",
            finishReason: "stop",
            usage: { input: 0, output: 0, total: 0 },
          };
        },
      },
    };

    const ai = agent({
      model: sdk.model({ name: "m" }),
      middleware: [shortCircuit],
    });

    const result = await ai.execute("hi");

    expect(result.text).toBe("cached-answer");
    expect(result.usage.total).toBe(0);
    expect(sdk.models[0].callCount).toBe(0);
  });

  it("trip.onError recovery returns a synthetic response; trip continues", async () => {
    const sdk = MockSDK({
      responses: [{ content: "", error: new Error("provider kaboom") }],
    });

    const recoverer: AgentMiddleware = {
      name: "fallback",
      trip: {
        onError() {
          return {
            content: "fallback-content",
            finishReason: "stop",
            usage: { input: 1, output: 1, total: 2 },
          };
        },
      },
    };

    const ai = agent({
      model: sdk.model({ name: "m" }),
      middleware: [recoverer],
    });

    const result = await ai.execute("hi");

    expect(result.error).toBeUndefined();
    expect(result.text).toBe("fallback-content");
    expect(result.usage.total).toBe(2);
  });
});

describe("agent + middleware — tool-level", () => {
  it("tool.before synthetic ToolInvokeResult.error records a failed tool call", async () => {
    const sdk = MockSDK({
      responses: [
        {
          content: "will call tool",
          finishReason: "tool_calls",
          toolCalls: [{ id: "1", name: "expensive", input: {} }],
        },
        { content: "done", finishReason: "stop" },
      ],
    });

    const rateLimit: AgentMiddleware = {
      name: "rate-limit",
      tool: {
        before() {
          const now = new Date().toISOString();
          const zeroUsage = { input: 0, output: 0, total: 0 };
          return {
            error: new AgentExecutionError("rate limited", {
              context: { tool: "expensive" },
            }),
            usage: zeroUsage,
            report: {
              runId: "tool_mw_stub",
              rootRunId: "tool_mw_stub",
              name: "expensive",
              type: "tool" as const,
              status: "failed" as const,
              startedAt: now,
              endedAt: now,
              duration: 0,
              usage: zeroUsage,
              children: [],
            },
          };
        },
      },
    };

    const expensiveTool = tool({
      name: "expensive",
      description: "test tool",
      input: emptyInput,
      execute: async () => "should-not-run",
    });

    const ai = agent({
      model: sdk.model({ name: "m" }),
      tools: [expensiveTool],
      middleware: [rateLimit],
    });

    const result = await ai.execute("hi");

    const toolCalls = result.report.children.filter(
      (child): child is typeof child & { type: "tool" } =>
        child.type === "tool",
    );
    expect(toolCalls).toHaveLength(1);
    const [firstCall] = toolCalls;
    expect((firstCall as { error?: unknown }).error).toBeInstanceOf(AIError);
    expect((firstCall as { output?: unknown }).output).toBeUndefined();
  });
});

describe("agent + middleware — streaming", () => {
  it("trip.before short-circuit works through stream() and closes the stream", async () => {
    const sdk = MockSDK({
      responses: [{ content: "real", finishReason: "stop" }],
    });

    const shortCircuit: AgentMiddleware = {
      name: "cache-like",
      trip: {
        before() {
          return {
            content: "from-middleware",
            finishReason: "stop",
            usage: { input: 0, output: 0, total: 0 },
          };
        },
      },
    };

    const ai = agent({
      model: sdk.model({ name: "m" }),
      middleware: [shortCircuit],
    });

    const stream = ai.stream("hi");

    const events: string[] = [];

    for await (const event of stream) {
      events.push(event.type);
    }

    const result = await stream.result;

    expect(result.text).toBe("from-middleware");
    expect(result.error).toBeUndefined();
    expect(events).toContain("agent.completed");
    expect(sdk.models[0].callCount).toBe(0);
  });
});

describe("agent + middleware — factory validation", () => {
  it("throws on duplicate middleware names at factory time", () => {
    const sdk = MockSDK({
      responses: [{ content: "x", finishReason: "stop" }],
    });

    const dupA: AgentMiddleware = { name: "same" };
    const dupB: AgentMiddleware = { name: "same" };

    expect(() =>
      agent({
        model: sdk.model({ name: "m" }),
        middleware: [dupA, dupB],
      }),
    ).toThrowError(/duplicate middleware name/);
  });

  it("throws when a middleware entry is missing a name", () => {
    const sdk = MockSDK({
      responses: [{ content: "x", finishReason: "stop" }],
    });

    expect(() =>
      agent({
        model: sdk.model({ name: "m" }),
        middleware: [{} as AgentMiddleware],
      }),
    ).toThrowError(/non-empty string "name"/);
  });

  it("throws when a middleware entry is null / undefined", () => {
    const sdk = MockSDK({
      responses: [{ content: "x", finishReason: "stop" }],
    });

    expect(() =>
      agent({
        model: sdk.model({ name: "m" }),
        middleware: [null as unknown as AgentMiddleware],
      }),
    ).toThrowError(/must be an object/);
  });
});
