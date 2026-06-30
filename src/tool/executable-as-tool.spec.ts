import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import { agent } from "../agent/agent";
import { END } from "../contracts/end.type";
import { AgentExecutionError } from "../errors";
import { MockSDK } from "../mock/mock-sdk";
import { supervisor } from "../supervisor/supervisor";
import { step } from "../workflow/step";
import { workflow } from "../workflow/workflow";
import {
  type AgentToolEntry,
  executableToTool,
  isExecutableTool,
  normalizeAgentTools,
} from "./executable-as-tool";
import { tool } from "./tool";

/** Hand-rolled Standard Schema accepting `{ topic: string }`. */
const topicSchema: StandardSchemaV1<{ topic: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => {
      if (value && typeof value === "object" && "topic" in value) {
        return { value: { topic: String((value as { topic: unknown }).topic) } };
      }

      return { issues: [{ message: "missing topic" }] };
    },
  },
};

/**
 * Build a caller agent scripted to invoke `toolName` once, then stop.
 * `tools` is typed as `AgentToolEntry[]` (no cast) so the test also
 * locks in that bare executables are accepted in `tools: []`.
 */
function callerAgent(toolName: string, toolInput: unknown, tools: AgentToolEntry[]) {
  const sdk = MockSDK({
    responses: [
      {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "c1", name: toolName, input: toolInput }],
      },
      { content: "done", finishReason: "stop" },
    ],
  });

  return agent({
    name: "caller",
    model: sdk.model({ name: "caller-model" }),
    tools,
  });
}

describe("isExecutableTool", () => {
  it("returns true for an executable (has execute, no invoke)", () => {
    const wf = workflow({ name: "wf", steps: [step({ name: "s", run: () => {} })] });

    expect(isExecutableTool(wf)).toBe(true);
  });

  it("returns false for a built ToolContract (has invoke)", () => {
    const built = tool({
      name: "leaf",
      description: "leaf tool",
      execute: async () => ({ ok: true }),
    });

    expect(isExecutableTool(built)).toBe(false);
  });

  it("returns false for non-objects and plain data", () => {
    expect(isExecutableTool(undefined)).toBe(false);
    expect(isExecutableTool(null)).toBe(false);
    expect(isExecutableTool("nope")).toBe(false);
    expect(isExecutableTool({ name: "x" })).toBe(false);
  });
});

describe("executableToTool", () => {
  it("derives name + description + schema from a workflow with inputSchema", () => {
    const wf = workflow<{ topic: string }, { answer: string }>({
      name: "answer-bot",
      description: "Answers a topic",
      inputSchema: topicSchema,
      steps: [
        step({
          name: "respond",
          run: (ctx) => {
            ctx.state.answer = `re: ${(ctx.input as { topic: string }).topic}`;
          },
        }),
      ],
      output: { extract: (ctx) => ({ answer: ctx.state.answer as string }) },
    });

    const wrapped = executableToTool(wf);

    expect(wrapped.name).toBe("answer-bot");
    expect(wrapped.description).toBe("Answers a topic");
    expect(wrapped.input).toBe(topicSchema);
  });

  it("falls back to a default description when the executable has none", () => {
    const wf = workflow({ name: "nameless-desc", steps: [step({ name: "s", run: () => {} })] });

    const wrapped = executableToTool(wf);

    expect(wrapped.description).toBe('Invoke "nameless-desc" as a tool.');
  });

  it("throws AgentExecutionError when the executable has no name", () => {
    const fake = {
      name: "",
      execute: async () => ({ usage: { input: 0, output: 0, total: 0 }, report: {} }),
    };

    expect(() => executableToTool(fake as never)).toThrow(AgentExecutionError);
  });

  it("relays the invoke ctx signal into the inner executable's execute options (C2)", async () => {
    const controller = new AbortController();
    let received: { signal?: AbortSignal } | undefined;

    const fake = {
      name: "capturer",
      execute: async (_input: unknown, options?: unknown) => {
        received = options as { signal?: AbortSignal };
        return { data: "ok", usage: { input: 0, output: 0, total: 0 }, report: {} as never };
      },
    };

    await executableToTool(fake as never).invoke(
      { topic: "x" },
      { artifacts: {}, signal: controller.signal },
    );

    expect(received?.signal).toBe(controller.signal);
  });

  it("omits the execute options object entirely when no signal is threaded (C2)", async () => {
    let received: unknown = "untouched";

    const fake = {
      name: "capturer",
      execute: async (_input: unknown, options?: unknown) => {
        received = options;
        return { data: "ok", usage: { input: 0, output: 0, total: 0 }, report: {} as never };
      },
    };

    await executableToTool(fake as never).invoke({ topic: "x" }, { artifacts: {} });

    expect(received).toBeUndefined();
  });
});

describe("normalizeAgentTools", () => {
  it("returns undefined when no tools are supplied", () => {
    expect(normalizeAgentTools(undefined)).toBeUndefined();
  });

  it("passes built ToolContracts through untouched (.asTool() still works)", () => {
    const built = tool({
      name: "leaf",
      description: "leaf tool",
      execute: async () => ({ ok: true }),
    });

    const normalized = normalizeAgentTools([built]);

    expect(normalized).toHaveLength(1);
    expect(normalized![0]).toBe(built);
  });

  it("wraps executables and leaves built tools alone in a mixed array", () => {
    const built = tool({
      name: "leaf",
      description: "leaf tool",
      execute: async () => ({ ok: true }),
    });
    const wf = workflow({
      name: "wf",
      inputSchema: topicSchema,
      steps: [step({ name: "s", run: () => {} })],
    });

    const normalized = normalizeAgentTools([built, wf]);

    expect(normalized![0]).toBe(built);
    expect(typeof normalized![1].invoke).toBe("function");
    expect(normalized![1].name).toBe("wf");
  });
});

describe("auto-adapt in tools: [] (no .asTool())", () => {
  it("an agent invokes a bare workflow placed directly in tools", async () => {
    const wf = workflow<{ topic: string }, { answer: string }>({
      name: "answer-bot",
      description: "Answers a topic",
      inputSchema: topicSchema,
      steps: [
        step({
          name: "respond",
          run: (ctx) => {
            ctx.state.answer = `re: ${(ctx.input as { topic: string }).topic}`;
          },
        }),
      ],
      output: { extract: (ctx) => ({ answer: ctx.state.answer as string }) },
    });

    const caller = callerAgent("answer-bot", { topic: "weather" }, [wf]);

    const result = await caller.execute("go");

    expect(result.error).toBeUndefined();

    const toolCalls = result.report.children.filter((child) => child.type === "tool");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("answer-bot");
    expect((toolCalls[0] as { output?: unknown }).output).toEqual({ answer: "re: weather" });
  });

  it("an agent invokes a bare supervisor placed directly in tools", async () => {
    const workerSdk = MockSDK({ responses: [{ content: "handled", finishReason: "stop" }] });
    const worker = agent({
      name: "worker",
      description: "does the work",
      model: workerSdk.model({ name: "worker-model" }),
    });

    const sup = supervisor({
      name: "team",
      intents: { worker },
      route: (ctx) => (ctx.iteration === 0 ? "worker" : END),
    });

    const caller = callerAgent("team", "please help", [sup]);

    const result = await caller.execute("go");

    expect(result.error).toBeUndefined();

    const toolCalls = result.report.children.filter((child) => child.type === "tool");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("team");
    // The inner supervisor report nests under the tool-call node.
    expect(toolCalls[0].children.length).toBeGreaterThan(0);
  });

  it("nests usage from the inner executable into the outer agent", async () => {
    const wf = workflow<{ topic: string }, { answer: string }>({
      name: "answer-bot",
      inputSchema: topicSchema,
      steps: [
        step({
          name: "respond",
          run: (ctx) => {
            ctx.state.answer = "ok";
          },
        }),
      ],
      output: { extract: () => ({ answer: "ok" }) },
    });

    const caller = callerAgent("answer-bot", { topic: "x" }, [wf]);

    const result = await caller.execute("go");

    expect(result.error).toBeUndefined();
    expect(result.usage.total).toBeGreaterThanOrEqual(0);
  });

  it("an outer agent threads its run signal into a nested executable tool (C2)", async () => {
    const controller = new AbortController();
    let received: { signal?: AbortSignal } | undefined;

    const fakeExecutable = {
      name: "capturer",
      description: "captures the options it receives",
      execute: async (_input: unknown, options?: unknown) => {
        received = options as { signal?: AbortSignal };
        return {
          data: { ok: true },
          usage: { input: 0, output: 0, total: 0 },
          report: {
            runId: "r1",
            rootRunId: "r1",
            name: "capturer",
            type: "workflow" as const,
            status: "completed" as const,
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            duration: 0,
            usage: { input: 0, output: 0, total: 0 },
            children: [],
          },
        };
      },
    };

    const caller = callerAgent("capturer", { topic: "x" }, [fakeExecutable as never]);

    await caller.execute("go", { signal: controller.signal });

    // The outer agent's run signal reached the nested executable's
    // execute() options — a cancellation of the parent now aborts the
    // child instead of letting it outlive the cancellation.
    expect(received?.signal).toBe(controller.signal);
  });

  it("surfaces an inner workflow failure as a failed tool call", async () => {
    const wf = workflow<{ topic: string }, unknown>({
      name: "explodes",
      inputSchema: topicSchema,
      steps: [
        step({
          name: "boom",
          run: () => {
            throw new Error("kaboom");
          },
        }),
      ],
    });

    const caller = callerAgent("explodes", { topic: "x" }, [wf]);

    const result = await caller.execute("go");

    const toolCalls = result.report.children.filter((child) => child.type === "tool");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].status).toBe("failed");
  });
});
