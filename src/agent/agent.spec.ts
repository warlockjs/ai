import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it, vi } from "vitest";
import type { Message } from "../contracts/conversation-message.type";
import type { AgentEventMap } from "../contracts/events/event-map.type";
import type { ToolCall } from "../contracts/result/tool-call.type";
import type {
  SystemPromptContract,
  SystemPromptMeta,
} from "../contracts/system-prompt.contract";
import { AgentExecutionError, AIError, SchemaValidationError } from "../errors";
import { MockModel } from "../mock/mock-model";
import { MockSDK } from "../mock/mock-sdk";
import { tool } from "../tool/tool";
import { systemPrompt } from "../system-prompt/system-prompt";
import { agent } from "./agent";

// ---------------------------------------------------------------------------
// Hand-rolled Standard Schema helpers (mirrors tool.spec.ts approach)
// ---------------------------------------------------------------------------

function makeSchema<T>(
  validate: (value: unknown) => StandardSchemaV1.Result<T>,
): StandardSchemaV1<T> {
  return { "~standard": { version: 1, vendor: "test", validate } };
}

const stringSchema = makeSchema<string>((v) =>
  typeof v === "string" ? { value: v } : { issues: [{ message: "expected string" }] },
);

/** A schema that always fails validation */
const rejectAllSchema = makeSchema<never>(() => ({
  issues: [{ message: "always invalid" }],
}));

/** A schema that parses objects with a "summary" field */
const summarySchema = makeSchema<{ summary: string }>((v) => {
  if (
    typeof v === "object" &&
    v !== null &&
    "summary" in v &&
    typeof (v as Record<string, unknown>)["summary"] === "string"
  ) {
    return {
      value: { summary: (v as Record<string, unknown>)["summary"] as string },
    };
  }
  return { issues: [{ message: "missing summary field" }] };
});

// ---------------------------------------------------------------------------
// Fake SystemPromptContract
// ---------------------------------------------------------------------------

function makeSystemPrompt(resolved: string): SystemPromptContract {
  return {
    blocks: [],
    meta(meta?: SystemPromptMeta): SystemPromptMeta | undefined | SystemPromptContract {
      return meta === undefined ? undefined : this;
    },
    instruction() {
      return this;
    },
    persona() {
      return this;
    },
    merge() {
      return this;
    },
    resolve(_placeholders) {
      return resolved;
    },
    validate() {
      return Promise.resolve({ ok: true, missing: [] });
    },
    refined(): never {
      throw new Error("refined() is not supported by this test fake");
    },
  } as SystemPromptContract;
}

/**
 * Like {@link makeSystemPrompt}, but the contract carries identity metadata
 * (`meta.name` / optional `meta.version`) so the prompt-version-linkage path
 * — which reads `prompt.meta()` to stamp `promptName` / `promptVersion` onto
 * the report — is exercised without touching the real `ai.prompts` registry.
 */
function makeNamedSystemPrompt(
  resolved: string,
  identity: SystemPromptMeta,
): SystemPromptContract {
  const prompt = makeSystemPrompt(resolved);

  return {
    ...prompt,
    meta(meta?: SystemPromptMeta): SystemPromptMeta | undefined | SystemPromptContract {
      return meta === undefined ? identity : prompt;
    },
  } as SystemPromptContract;
}

// ---------------------------------------------------------------------------
// Utility: capture events in order
// ---------------------------------------------------------------------------

function eventCapture() {
  const log: Array<{ event: string; payload: unknown }> = [];
  const on: Partial<{
    [K in keyof AgentEventMap]: (payload: AgentEventMap[K]) => void;
  }> = {};

  const events: Array<keyof AgentEventMap> = [
    "agent.starting",
    "agent.trip.started",
    "agent.trip.completed",
    "agent.completed",
    "agent.tool.calling",
    "agent.tool.called",
    "agent.tool.failed",
    "agent.error",
  ];

  for (const name of events) {
    on[name] = (payload: unknown) => log.push({ event: name, payload });
  }

  return { on, log };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agent()", () => {
  // 1. Single trip, no tools — returns text
  it("executes a single trip with no tools and returns text", async () => {
    const mock = MockSDK({
      responses: [{ content: "Hello there!", finishReason: "stop" }],
    });
    const model = mock.model({ name: "mock-gpt" });

    const myAgent = agent({ model });
    const result = await myAgent.execute("Say hello");

    expect(result.type).toBe("agent");
    expect(result.text).toBe("Hello there!");
    expect(result.error).toBeUndefined();
    expect(result.report.trips).toHaveLength(1);
    expect(result.report.trips[0].finishReason).toBe("stop");
  });

  it("captures the resolved string system prompt on the report", async () => {
    const mock = MockSDK({ responses: [{ content: "ok", finishReason: "stop" }] });
    const model = mock.model({ name: "mock-gpt" });

    const result = await agent({ model, systemPrompt: "You are a helpful assistant." }).execute("hi");

    expect(result.report.systemPrompt).toBe("You are a helpful assistant.");
  });

  it("captures a resolved SystemPromptContract on the report", async () => {
    const mock = MockSDK({ responses: [{ content: "ok", finishReason: "stop" }] });
    const model = mock.model({ name: "mock-gpt" });

    const result = await agent({ model, systemPrompt: makeSystemPrompt("Persona + rules") }).execute("hi");

    expect(result.report.systemPrompt).toBe("Persona + rules");
  });

  it("leaves report.systemPrompt undefined when no system prompt is configured", async () => {
    const mock = MockSDK({ responses: [{ content: "ok", finishReason: "stop" }] });
    const model = mock.model({ name: "mock-gpt" });

    const result = await agent({ model }).execute("hi");

    expect(result.report.systemPrompt).toBeUndefined();
  });

  // 2. Aggregates usage across trips
  it("aggregates usage across multiple trips", async () => {
    const mock = MockSDK({
      responses: [
        {
          content: "",
          finishReason: "tool_calls",
          usage: { input: 100, output: 20, total: 120 },
          toolCalls: [{ id: "call_1", name: "echo", input: "hi" }],
        },
        {
          content: "Done",
          finishReason: "stop",
          usage: { input: 50, output: 30, total: 80 },
        },
      ],
    });
    const model = mock.model({ name: "mock" });

    const echoTool = tool({
      name: "echo",
      description: "Echo",
      input: stringSchema,
      execute: async (s: string) => s,
    });

    const myAgent = agent({ model, tools: [echoTool] });
    const result = await myAgent.execute("Go");

    expect(result.usage.input).toBe(150);
    expect(result.usage.output).toBe(50);
    expect(result.usage.total).toBe(200);
  });

  // 3. Duration > 0
  it("reports a total duration greater than 0", async () => {
    const mock = MockSDK({
      responses: [{ content: "fast", finishReason: "stop" }],
    });
    const model = mock.model({ name: "mock" });

    const result = await agent({ model }).execute("ping");
    expect(result.report.duration).toBeGreaterThanOrEqual(0);
    expect(typeof result.report.duration).toBe("number");
  });

  // 3b. Report carries status="completed" and valid ISO timestamps on success
  it("populates report.status=completed and ISO startedAt/endedAt on success", async () => {
    const mock = MockSDK({
      responses: [{ content: "ok", finishReason: "stop" }],
    });
    const model = mock.model({ name: "mock" });

    const result = await agent({ model }).execute("ping");

    expect(result.report.status).toBe("completed");
    expect(typeof result.report.startedAt).toBe("string");
    expect(typeof result.report.endedAt).toBe("string");
    expect(Number.isNaN(Date.parse(result.report.startedAt))).toBe(false);
    expect(Number.isNaN(Date.parse(result.report.endedAt))).toBe(false);
    expect(Date.parse(result.report.endedAt)).toBeGreaterThanOrEqual(
      Date.parse(result.report.startedAt),
    );
  });

  // 3c. Report carries status="failed" on error
  it("populates report.status=failed when the agent errors", async () => {
    const mock = MockSDK({
      responses: [{ content: "", error: new Error("boom") }],
    });
    const model = mock.model({ name: "mock" });

    const result = await agent({ model }).execute("boom");

    expect(result.report.status).toBe("failed");
    expect(result.error).toBeDefined();
  });

  // 3c-bis. Each trip and tool call carries ISO startedAt/endedAt
  it("populates startedAt/endedAt on every trip and every tool call", async () => {
    const mock = MockSDK({
      responses: [
        {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "c1", name: "echo", input: "x" }],
        },
        { content: "done", finishReason: "stop" },
      ],
    });
    const model = mock.model({ name: "mock" });
    const echoTool = tool({
      name: "echo",
      description: "Echo",
      input: stringSchema,
      execute: async (s: string) => s,
    });

    const result = await agent({ model, tools: [echoTool] }).execute("go");

    for (const trip of result.report.trips) {
      expect(typeof trip.startedAt).toBe("string");
      expect(typeof trip.endedAt).toBe("string");
      expect(Number.isNaN(Date.parse(trip.startedAt))).toBe(false);
      expect(Date.parse(trip.endedAt)).toBeGreaterThanOrEqual(Date.parse(trip.startedAt));
    }

    expect(result.report.children).toHaveLength(1);
    const toolCall = result.report.children[0];
    expect(typeof toolCall.startedAt).toBe("string");
    expect(typeof toolCall.endedAt).toBe("string");
    expect(Number.isNaN(Date.parse(toolCall.startedAt))).toBe(false);
    expect(Date.parse(toolCall.endedAt)).toBeGreaterThanOrEqual(Date.parse(toolCall.startedAt));
  });

  // 3d. Canonical destructuring shape
  it("supports the canonical { data, text, report, usage, error } destructuring", async () => {
    const mock = MockSDK({
      responses: [{ content: "hello", finishReason: "stop" }],
    });
    const model = mock.model({ name: "mock" });

    const { data, text, report, usage, error } = await agent({ model }).execute("hi");

    expect(data).toBeUndefined();
    expect(text).toBe("hello");
    expect(report.trips).toHaveLength(1);
    expect(report.children).toEqual([]);
    expect(usage.total).toBeGreaterThanOrEqual(0);
    expect(error).toBeUndefined();
  });

  // 4. Emits events in order
  it("emits starting, trip-started, trip-completed, completed in order", async () => {
    const mock = MockSDK({
      responses: [{ content: "ok", finishReason: "stop" }],
    });
    const model = mock.model({ name: "mock" });
    const { on, log } = eventCapture();

    await agent({ model }).execute("test", { on });

    const names = log.map((e) => e.event);
    expect(names).toEqual(
      expect.arrayContaining([
        "agent.starting",
        "agent.trip.started",
        "agent.trip.completed",
        "agent.completed",
      ]),
    );
    // Order check: starting < trip-started < trip-completed < completed
    const startIdx = names.indexOf("agent.starting");
    const tripStartIdx = names.indexOf("agent.trip.started");
    const tripEndIdx = names.indexOf("agent.trip.completed");
    const completedIdx = names.indexOf("agent.completed");
    expect(startIdx).toBeLessThan(tripStartIdx);
    expect(tripStartIdx).toBeLessThan(tripEndIdx);
    expect(tripEndIdx).toBeLessThan(completedIdx);
  });

  // 5. System prompt string becomes first message
  it("passes system prompt string as first system message", async () => {
    const mock = MockSDK({
      responses: [{ content: "ok", finishReason: "stop" }],
    });
    const model: MockModel = mock.model({ name: "mock" }) as MockModel;

    await agent({ model, systemPrompt: "Be concise." }).execute("Hi");

    const firstCall = model.callHistory[0];
    expect(firstCall.messages[0]).toEqual<Message>({
      role: "system",
      content: "Be concise.",
    });
  });

  // 6. SystemPromptContract.resolve() result as first message
  it("calls SystemPromptContract.resolve() and uses its result as system message", async () => {
    const mock = MockSDK({
      responses: [{ content: "ok", finishReason: "stop" }],
    });
    const model: MockModel = mock.model({ name: "mock" }) as MockModel;

    const prompt = makeSystemPrompt("Resolved system prompt");
    const resolveSpy = vi.spyOn(prompt, "resolve");

    await agent({ model, systemPrompt: prompt }).execute("Hi");

    expect(resolveSpy).toHaveBeenCalledOnce();
    const firstCall = model.callHistory[0];
    expect(firstCall.messages[0].content).toBe("Resolved system prompt");
  });

  // 6b. Prompt-version linkage: a named SystemPromptContract stamps
  //     promptName + promptVersion onto the report.
  it("records promptName + promptVersion on the report from a named prompt", async () => {
    const mock = MockSDK({
      responses: [{ content: "ok", finishReason: "stop" }],
    });
    const model = mock.model({ name: "mock" });

    const named = systemPrompt("You are support.", {
      name: "support-agent",
      version: "3",
    });

    const { report } = await agent({ model, systemPrompt: named }).execute("Hi");

    expect(report.promptName).toBe("support-agent");
    expect(report.promptVersion).toBe("3");
  });

  // 6c. A named prompt WITHOUT an explicit version defaults to "1"
  //     (mirroring the ai.prompts registry default).
  it("defaults promptVersion to \"1\" for a named prompt with no version", async () => {
    const mock = MockSDK({
      responses: [{ content: "ok", finishReason: "stop" }],
    });
    const model = mock.model({ name: "mock" });

    const named = makeNamedSystemPrompt("Resolved.", { name: "greeter" });

    const { report } = await agent({ model, systemPrompt: named }).execute("Hi");

    expect(report.promptName).toBe("greeter");
    expect(report.promptVersion).toBe("1");
  });

  // 6d. An anonymous contract (no meta.name) leaves the linkage fields absent.
  it("omits promptName / promptVersion for an anonymous prompt", async () => {
    const mock = MockSDK({
      responses: [{ content: "ok", finishReason: "stop" }],
    });
    const model = mock.model({ name: "mock" });

    const anonymous = makeSystemPrompt("Resolved system prompt");

    const { report } = await agent({ model, systemPrompt: anonymous }).execute(
      "Hi",
    );

    expect(report.promptName).toBeUndefined();
    expect(report.promptVersion).toBeUndefined();
  });

  // 6e. A raw-string system prompt carries no registry identity either.
  it("omits promptName / promptVersion for a raw-string system prompt", async () => {
    const mock = MockSDK({
      responses: [{ content: "ok", finishReason: "stop" }],
    });
    const model = mock.model({ name: "mock" });

    const { report } = await agent({
      model,
      systemPrompt: "Be concise.",
    }).execute("Hi");

    expect(report.promptName).toBeUndefined();
    expect(report.promptVersion).toBeUndefined();
  });

  // 7. Merges factory + execute placeholders (execute wins)
  it("merges factory and execute placeholders — execute options win on conflict", async () => {
    const mock = MockSDK({
      responses: [{ content: "ok", finishReason: "stop" }],
    });
    const model = mock.model({ name: "mock" });

    const resolveMock = vi.fn((_p?: Record<string, unknown>) => "resolved");
    const prompt = {
      meta(meta?: SystemPromptMeta): SystemPromptMeta | undefined | SystemPromptContract {
        return meta === undefined ? undefined : this;
      },
      instruction() {
        return this;
      },
      persona() {
        return this;
      },
      merge() {
        return this;
      },
      blocks: [],
      resolve: resolveMock,
      validate() {
        return Promise.resolve({ ok: true, missing: [] });
      },
      refined(): never {
        throw new Error("refined() is not supported by this test fake");
      },
    } as SystemPromptContract;

    await agent({
      model,
      systemPrompt: prompt,
      placeholders: { lang: "Arabic", style: "formal" },
    }).execute("Hi", {
      placeholders: { lang: "English" }, // should win
    });

    expect(resolveMock).toHaveBeenCalledWith({
      lang: "English",
      style: "formal",
    });
  });

  // 8. Prepends history messages before user input
  it("prepends history messages before the user input message", async () => {
    const mock = MockSDK({
      responses: [{ content: "ok", finishReason: "stop" }],
    });
    const model: MockModel = mock.model({ name: "mock" }) as MockModel;

    const history: Message[] = [
      { role: "user", content: "Previous question" },
      { role: "assistant", content: "Previous answer" },
    ];

    await agent({ model }).execute("New question", { history });

    const messages = model.callHistory[0].messages;
    expect(messages[0]).toMatchObject({
      role: "user",
      content: "Previous question",
    });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "Previous answer",
    });
    expect(messages[2]).toMatchObject({
      role: "user",
      content: "New question",
    });
  });

  // 9. Invokes a tool when model returns tool_calls
  it("invokes the registered tool when model returns finishReason tool_calls", async () => {
    const executeSpy = vi.fn(async (_: string) => "tool result");

    const myTool = tool({
      name: "echo",
      description: "Echo",
      input: stringSchema,
      execute: executeSpy,
    });

    const mock = MockSDK({
      responses: [
        {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "call_1", name: "echo", input: "hello" }],
        },
        { content: "Done with tool", finishReason: "stop" },
      ],
    });
    const model = mock.model({ name: "mock" });

    const result = await agent({ model, tools: [myTool] }).execute("Use echo");

    expect(executeSpy).toHaveBeenCalledOnce();
    expect(result.report.children).toHaveLength(1);
    expect(result.report.children[0].name).toBe("echo");
    expect((result.report.children[0] as ToolCall).output).toBe("tool result");
  });

  // 10. Emits tool-calling and tool-called around invocation
  it("emits tool-calling before invoke and tool-called after successful invoke", async () => {
    const myTool = tool({
      name: "echo",
      description: "Echo",
      input: stringSchema,
      execute: async (s: string) => s,
    });

    const mock = MockSDK({
      responses: [
        {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "call_1", name: "echo", input: "hi" }],
        },
        { content: "Done", finishReason: "stop" },
      ],
    });
    const model = mock.model({ name: "mock" });
    const { on, log } = eventCapture();

    await agent({ model, tools: [myTool] }).execute("Go", { on });

    const eventNames = log.map((e) => e.event);
    expect(eventNames).toContain("agent.tool.calling");
    expect(eventNames).toContain("agent.tool.called");

    const callingIdx = eventNames.indexOf("agent.tool.calling");
    const calledIdx = eventNames.indexOf("agent.tool.called");
    expect(callingIdx).toBeLessThan(calledIdx);
  });

  // 11. Tool output appears in follow-up trip's messages
  it("appends the tool result to messages so the next trip sees it", async () => {
    const myTool = tool({
      name: "echo",
      description: "Echo",
      input: stringSchema,
      execute: async (s: string) => `echo:${s}`,
    });

    const mock = MockSDK({
      responses: [
        {
          content: "thinking",
          finishReason: "tool_calls",
          toolCalls: [{ id: "call_x", name: "echo", input: "world" }],
        },
        { content: "Done", finishReason: "stop" },
      ],
    });
    const model: MockModel = mock.model({ name: "mock" }) as MockModel;

    await agent({ model, tools: [myTool] }).execute("Use echo");

    // The second call (trip 2) should include a tool-result message
    const secondCallMessages = model.callHistory[1].messages;
    const toolResultMsg = secondCallMessages.find((m: Message) => m.role === "tool");
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg?.toolCallId).toBe("call_x");
    expect(toolResultMsg?.content).toBe(JSON.stringify("echo:world"));
  });

  // 12. Records a ToolCall with duration and input/output
  it("records a ToolCall with name, input, output, duration, and tripIndex", async () => {
    const myTool = tool({
      name: "add",
      description: "Add",
      input: stringSchema,
      execute: async (_: string) => 42,
    });

    const mock = MockSDK({
      responses: [
        {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "c1", name: "add", input: "nums" }],
        },
        { content: "Result is 42", finishReason: "stop" },
      ],
    });
    const model = mock.model({ name: "mock" });

    const result = await agent({ model, tools: [myTool] }).execute("Add");

    expect(result.report.children).toHaveLength(1);
    const tc = result.report.children[0] as ToolCall;
    expect(tc.name).toBe("add");
    expect(tc.input).toBe("nums");
    expect(tc.output).toBe(42);
    expect(tc.tripIndex).toBe(0);
    expect(typeof tc.duration).toBe("number");
    expect(tc.duration).toBeGreaterThanOrEqual(0);
  });

  // 13. Tool not found — records error ToolCall, emits tool-calling-failed, loop continues
  it("records an error ToolCall when tool is not registered and does not crash the loop", async () => {
    const mock = MockSDK({
      responses: [
        {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "c_unknown", name: "unknownTool", input: {} }],
        },
        { content: "Recovered", finishReason: "stop" },
      ],
    });
    const model = mock.model({ name: "mock" });
    const { on, log } = eventCapture();

    const result = await agent({ model, tools: [] }).execute("go", { on });

    expect(result.report.children).toHaveLength(1);
    const unknownCall = result.report.children[0] as ToolCall;
    expect(unknownCall.error).toBeInstanceOf(AgentExecutionError);
    expect(unknownCall.error?.code).toBe("AGENT_EXEC_FAILED");
    expect(unknownCall.error?.message).toContain("Tool not registered: unknownTool");

    const eventNames = log.map((e) => e.event);
    expect(eventNames).toContain("agent.tool.failed");

    // Loop continued — second trip happened and agent completed
    expect(result.text).toBe("Recovered");
    expect(result.error).toBeUndefined();
  });

  // 14. Tool invoke surfaces error; ToolCall has error field
  it("records error in ToolCall when the tool execute() throws", async () => {
    const failTool = tool({
      name: "fail",
      description: "Always fails",
      input: stringSchema,
      execute: async (_: string) => {
        throw new Error("tool boom");
      },
    });

    const mock = MockSDK({
      responses: [
        {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "c1", name: "fail", input: "go" }],
        },
        { content: "Handled", finishReason: "stop" },
      ],
    });
    const model = mock.model({ name: "mock" });
    const { on, log } = eventCapture();

    const result = await agent({ model, tools: [failTool] }).execute("fail please", { on });

    const failedCall = result.report.children[0] as ToolCall;
    expect(failedCall.error?.message).toBe("tool boom");
    expect(failedCall.error?.code).toBe("TOOL_EXEC_FAILED");
    expect(failedCall.output).toBeUndefined();

    const eventNames = log.map((e) => e.event);
    expect(eventNames).toContain("agent.tool.failed");
  });

  // 15. Respects maxTrips cap
  it("returns an error when maxTrips is exceeded without a natural stop", async () => {
    // All responses are tool_calls — the loop will never naturally stop
    const loopTool = tool({
      name: "loop",
      description: "Forces a loop",
      input: stringSchema,
      execute: async (_: string) => "looping",
    });

    const mock = MockSDK({
      responses: [
        {
          content: "...",
          finishReason: "tool_calls",
          toolCalls: [{ id: "c", name: "loop", input: "x" }],
        },
      ],
    });
    const model = mock.model({ name: "mock" });

    const result = await agent({
      model,
      tools: [loopTool],
      maxTrips: 3,
    }).execute("loop forever");

    expect(result.error?.message).toBe("Max trips exceeded");
    // Specialized subclass — still passes the broader AgentExecutionError check.
    expect(result.error).toBeInstanceOf(AgentExecutionError);
    expect(result.error?.code).toBe("AGENT_MAX_TRIPS");
    expect(result.error?.category).toBe("max-trips");
    expect(result.report.trips).toHaveLength(3);
  });

  // 16. Parses structured output when `output` schema provided
  it("parses structured output when output schema is provided and model returns valid JSON", async () => {
    const mock = MockSDK({
      responses: [{ content: '{"summary":"AI is great"}', finishReason: "stop" }],
    });
    const model = mock.model({ name: "mock" });

    const result = await agent({ model }).execute("Summarize", {
      output: summarySchema,
    });

    expect(result.data).toEqual({ summary: "AI is great" });
    expect(result.error).toBeUndefined();
  });

  // 17. Populates result.error when output parsing fails (bad JSON)
  it("sets result.error when model output is not valid JSON", async () => {
    const mock = MockSDK({
      responses: [{ content: "not json at all", finishReason: "stop" }],
    });
    const model = mock.model({ name: "mock" });

    const result = await agent({ model }).execute("go", {
      output: summarySchema,
    });

    expect(result.error?.message).toContain("Failed to parse model output as JSON");
    expect(result.error).toBeInstanceOf(SchemaValidationError);
    expect(result.error?.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(result.data).toBeUndefined();
    expect(result.text).toBe("not json at all");
  });

  // 17b. Populates result.error when schema validation fails
  it("sets result.error when output passes JSON parse but fails schema validation", async () => {
    const mock = MockSDK({
      responses: [{ content: '{"wrong":"field"}', finishReason: "stop" }],
    });
    const model = mock.model({ name: "mock" });

    const result = await agent({ model }).execute("go", {
      output: summarySchema,
    });

    expect(result.error?.message).toContain("missing summary field");
    expect(result.error).toBeInstanceOf(SchemaValidationError);
    expect((result.error as SchemaValidationError).issues).toBeDefined();
    expect(result.data).toBeUndefined();
  });

  // 18. Never throws from execute() — returns error in result even on model failure
  it("never throws from execute() when the model throws — wraps error in result", async () => {
    const mock = MockSDK({
      responses: [{ content: "", error: new Error("model crashed") }],
    });
    const model = mock.model({ name: "mock" });

    let threw = false;
    let result: Awaited<ReturnType<ReturnType<typeof agent>["execute"]>> | undefined;

    try {
      result = await agent({ model }).execute("boom");
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result?.error?.message).toBe("model crashed");
    expect(result?.error).toBeInstanceOf(AIError);
    expect(result?.error).toBeInstanceOf(AgentExecutionError);
    expect(result?.type).toBe("agent");
  });

  // 19. User event handler throwing does not crash the agent
  it("does not crash when an event handler throws", async () => {
    const mock = MockSDK({
      responses: [{ content: "fine", finishReason: "stop" }],
    });
    const model = mock.model({ name: "mock" });

    let threw = false;
    let result: Awaited<ReturnType<ReturnType<typeof agent>["execute"]>> | undefined;

    try {
      result = await agent({ model }).execute("test", {
        on: {
          "agent.completed": () => {
            throw new Error("handler exploded");
          },
        },
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result?.text).toBe("fine");
    expect(result?.error).toBeUndefined();
  });

  // 20. stream() yields delta events and resolves result
  it("stream() yields delta events and resolves the final result", async () => {
    const mock = MockSDK({
      responses: [{ content: "Hello world", finishReason: "stop" }],
    });
    const model = mock.model({ name: "mock" });

    const myAgent = agent({ model });
    const stream = myAgent.stream("hi");

    const deltas: string[] = [];

    for await (const event of stream) {
      if (event.type === "agent.trip.streaming") {
        deltas.push(event.delta);
      }
    }

    const result = await stream.result;

    expect(deltas.join("")).toContain("Hello");
    expect(result.text).toBe("Hello world ");
    expect(result.error).toBeUndefined();
  });

  // 20b. stream() on() handlers fire
  it("stream().on() handlers fire for matching event types", async () => {
    const mock = MockSDK({
      responses: [{ content: "ok", finishReason: "stop" }],
    });
    const model = mock.model({ name: "mock" });

    const myAgent = agent({ model });
    const deltas: string[] = [];
    let completed = false;

    const stream = myAgent.stream("hi").on({
      "agent.trip.streaming": (event) => {
        if (event.type === "agent.trip.streaming") {
          deltas.push(event.delta);
        }
      },
      "agent.completed": () => {
        completed = true;
      },
    });

    await stream.result;

    expect(deltas.length).toBeGreaterThan(0);
    expect(completed).toBe(true);
  });

  // 20c. stream() surfaces model errors via both channels
  it("stream() emits error event and rejects result on model failure", async () => {
    const mock = MockSDK({
      responses: [{ content: "", error: new Error("boom") }],
    });
    const model = mock.model({ name: "mock" });

    const myAgent = agent({ model });
    const stream = myAgent.stream("hi");

    const events: string[] = [];

    for await (const event of stream) {
      events.push(event.type);
    }

    const result = await stream.result;

    expect(events).toContain("agent.error");
    expect(result.error?.message).toBe("boom");
    expect(result.error).toBeInstanceOf(AIError);
  });

  // 20d. Three-tier subscription — factory, instance, per-call fire in order
  it("fires factory → instance → per-call handlers in that order", async () => {
    const mock = MockSDK({
      responses: [{ content: "ok", finishReason: "stop" }],
    });
    const model = mock.model({ name: "mock" });
    const order: string[] = [];

    const myAgent = agent({
      model,
      on: { "agent.starting": () => order.push("factory") },
    });

    myAgent.on("agent.starting", () => order.push("instance"));

    await myAgent.execute("hi", {
      on: { "agent.starting": () => order.push("perCall") },
    });

    expect(order).toEqual(["factory", "instance", "perCall"]);
  });

  // 20e. Instance .on() returns unsubscribe fn that removes the handler
  it(".on() returns a working unsubscribe function", async () => {
    const mock = MockSDK({
      responses: [{ content: "ok", finishReason: "stop" }],
    });
    const model = mock.model({ name: "mock" });

    const myAgent = agent({ model });
    let count = 0;

    const unsubscribe = myAgent.on("agent.starting", () => {
      count++;
    });

    await myAgent.execute("one");
    unsubscribe();
    await myAgent.execute("two");

    expect(count).toBe(1);
  });

  // 20f. Instance .off() removes a specific handler without disturbing others
  it(".off() removes only the specified handler", async () => {
    const mock = MockSDK({
      responses: [
        { content: "a", finishReason: "stop" },
        { content: "b", finishReason: "stop" },
      ],
    });
    const model = mock.model({ name: "mock" });
    const myAgent = agent({ model });
    let a = 0;
    let b = 0;
    const handlerA = () => {
      a++;
    };
    const handlerB = () => {
      b++;
    };

    myAgent.on("agent.starting", handlerA);
    myAgent.on("agent.starting", handlerB);

    await myAgent.execute("one");
    expect(a).toBe(1);
    expect(b).toBe(1);

    myAgent.off("agent.starting", handlerA);

    await myAgent.execute("two");
    expect(a).toBe(1);
    expect(b).toBe(2);
  });

  // 20g. All three tiers fire on stream() too
  it("all three tiers fire on stream()", async () => {
    const mock = MockSDK({
      responses: [{ content: "hi", finishReason: "stop" }],
    });
    const model = mock.model({ name: "mock" });
    const order: string[] = [];

    const myAgent = agent({
      model,
      on: { "agent.completed": () => order.push("factory") },
    });
    myAgent.on("agent.completed", () => order.push("instance"));

    const stream = myAgent.stream("go", {
      on: { "agent.completed": () => order.push("perCall") },
    });

    await stream.result;

    expect(order).toEqual(["factory", "instance", "perCall"]);
  });

  // 21. ai.agent namespace
  // Dynamically importing the full `../ai` facade cold-transforms the entire
  // primitive graph through vitest's esbuild; as the facade grows this cold
  // import can exceed the default 5s test budget (a test-time transform cost
  // only — the shipped package is precompiled JS). The assertion is a trivial
  // identity check, so allow a generous timeout for the one-time cold import.
  it("ai.agent from @warlock.js/ai points to the same factory function", async () => {
    const { ai } = await import("../ai");
    expect(ai.agent).toBe(agent);
  }, 30_000);

  // 22. No system message when systemPrompt is absent
  it("omits the system message when no systemPrompt is configured", async () => {
    const mock = MockSDK({
      responses: [{ content: "ok", finishReason: "stop" }],
    });
    const model: MockModel = mock.model({ name: "mock" }) as MockModel;

    await agent({ model }).execute("Hello");

    const messages = model.callHistory[0].messages;
    const systemMessages = messages.filter((m: Message) => m.role === "system");
    expect(systemMessages).toHaveLength(0);
  });

  // 23. output schema: reject all schema sets error, keeps text + trips
  it("keeps text and trips populated even when output schema validation fails", async () => {
    const mock = MockSDK({
      responses: [{ content: '{"x":1}', finishReason: "stop" }],
    });
    const model = mock.model({ name: "mock" });

    const result = await agent({ model }).execute("go", {
      output: rejectAllSchema,
    });

    expect(result.error).toBeDefined();
    expect(result.text).toBe('{"x":1}');
    expect(result.report.trips).toHaveLength(1);
  });

  // 26. Structured output: strips ```json fences before parsing
  it("strips markdown fences from model output before JSON-parsing against schema", async () => {
    const mock = MockSDK({
      responses: [
        {
          content: '```json\n{"summary":"AI is great"}\n```',
          finishReason: "stop",
        },
      ],
    });
    const model = mock.model({ name: "mock" });

    const result = await agent({ model }).execute("Summarize", {
      output: summarySchema,
    });

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ summary: "AI is great" });
  });

  // 27. Structured output: strips fences even with prose surrounding
  it("extracts JSON from a fenced block surrounded by prose", async () => {
    const mock = MockSDK({
      responses: [
        {
          content: 'Here you go:\n```json\n{"summary":"Cairo"}\n```\nLet me know.',
          finishReason: "stop",
        },
      ],
    });
    const model = mock.model({ name: "mock" });

    const result = await agent({ model }).execute("q", {
      output: summarySchema,
    });

    expect(result.data).toEqual({ summary: "Cairo" });
  });

  // 28. Structured output: injects JSON instruction when model has no capability
  it("injects a JSON-only system instruction when model has no structuredOutput capability", async () => {
    const mock = MockSDK({
      responses: [{ content: '{"summary":"x"}', finishReason: "stop" }],
    });
    const model: MockModel = mock.model({ name: "mock" }) as MockModel;

    await agent({ model, systemPrompt: "Be concise." }).execute("hi", {
      output: summarySchema,
    });

    const systemMessage = model.callHistory[0].messages[0];
    expect(systemMessage.role).toBe("system");
    expect(systemMessage.content).toMatch(/Be concise\./);
    expect(systemMessage.content).toMatch(/valid JSON/i);
    expect(systemMessage.content).toMatch(/prose/i);
  });

  // 29. Structured output: does NOT inject instruction when model supports it natively
  it("skips JSON instruction injection when model declares structuredOutput capability", async () => {
    const capableModel: MockModel = Object.assign(
      new MockModel("mock", [{ content: '{"summary":"x"}', finishReason: "stop" }]),
      { capabilities: { structuredOutput: true } },
    );

    await agent({ model: capableModel, systemPrompt: "Be concise." }).execute("hi", {
      output: summarySchema,
    });

    const systemMessage = capableModel.callHistory[0].messages[0];
    expect(systemMessage.content).toBe("Be concise.");
    expect(systemMessage.content).not.toMatch(/valid JSON/i);
  });

  // 30. Structured output: responseSchema forwarded to model via ModelCallOptions
  it("forwards a JSON Schema extracted from the output schema as ModelCallOptions.responseSchema", async () => {
    const schemaWithJsonSchema: StandardSchemaV1<{ summary: string }> & {
      jsonSchema: Record<string, unknown>;
    } = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (v) =>
          typeof v === "object" && v !== null && "summary" in v
            ? { value: v as { summary: string } }
            : { issues: [{ message: "bad" }] },
      },
      jsonSchema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
    };

    const mock = MockSDK({
      responses: [{ content: '{"summary":"x"}', finishReason: "stop" }],
    });
    const model: MockModel = mock.model({ name: "mock" }) as MockModel;

    await agent({ model }).execute("hi", { output: schemaWithJsonSchema });

    const options = model.callHistory[0].options;
    expect(options?.responseSchema).toEqual(schemaWithJsonSchema.jsonSchema);
  });

  // 31. Structured output: explicit responseSchema override wins over extraction
  it("uses options.responseSchema verbatim when provided, skipping extraction", async () => {
    const schemaWithOwnJsonSchema: StandardSchemaV1<{ summary: string }> & {
      jsonSchema: Record<string, unknown>;
    } = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (v) =>
          typeof v === "object" && v !== null && "summary" in v
            ? { value: v as { summary: string } }
            : { issues: [{ message: "bad" }] },
      },
      jsonSchema: { type: "object", properties: { extracted: {} } },
    };

    const hand = {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    };

    const mock = MockSDK({
      responses: [{ content: '{"summary":"x"}', finishReason: "stop" }],
    });
    const model: MockModel = mock.model({ name: "mock" }) as MockModel;

    await agent({ model }).execute("hi", {
      output: schemaWithOwnJsonSchema,
      responseSchema: hand,
    });

    expect(model.callHistory[0].options?.responseSchema).toEqual(hand);
  });

  // 32. Repair: opt-in re-ask recovers from a validation failure
  it("repairs an invalid response when repair is enabled and the re-ask succeeds", async () => {
    const mock = MockSDK({
      responses: [
        { content: '{"wrong":"field"}', finishReason: "stop" },
        { content: '{"summary":"recovered"}', finishReason: "stop" },
      ],
    });
    const model: MockModel = mock.model({ name: "mock" }) as MockModel;

    const result = await agent({ model }).execute("go", {
      output: summarySchema,
      repair: { maxAttempts: 1 },
    });

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ summary: "recovered" });
    expect(result.report.trips).toHaveLength(2);
    expect(model.callCount).toBe(2);

    const repairCallMessages = model.callHistory[1].messages;
    const lastMessage = repairCallMessages[repairCallMessages.length - 1];
    expect(lastMessage.role).toBe("user");
    expect(lastMessage.content).toContain("missing summary field");
    expect(lastMessage.content).toContain("valid JSON only");

    const previousAssistant = repairCallMessages[repairCallMessages.length - 2];
    expect(previousAssistant.role).toBe("assistant");
    expect(previousAssistant.content).toBe('{"wrong":"field"}');
  });

  // 33. Repair: surfaces the last failure when every attempt fails
  it("surfaces the final validation error when every repair attempt fails", async () => {
    const mock = MockSDK({
      responses: [
        { content: '{"wrong":"a"}', finishReason: "stop" },
        { content: '{"wrong":"b"}', finishReason: "stop" },
        { content: '{"wrong":"c"}', finishReason: "stop" },
      ],
    });
    const model: MockModel = mock.model({ name: "mock" }) as MockModel;

    const result = await agent({ model }).execute("go", {
      output: summarySchema,
      repair: { maxAttempts: 2 },
    });

    expect(result.error?.message).toContain("missing summary field");
    expect(result.data).toBeUndefined();
    expect(result.report.trips).toHaveLength(3);
    expect(model.callCount).toBe(3);
    expect(result.text).toBe('{"wrong":"c"}');
  });

  // 34. Repair: disabled by default — no extra trips on failure
  it("does not retry when repair is not configured", async () => {
    const mock = MockSDK({
      responses: [
        { content: '{"wrong":"field"}', finishReason: "stop" },
        { content: '{"summary":"never used"}', finishReason: "stop" },
      ],
    });
    const model: MockModel = mock.model({ name: "mock" }) as MockModel;

    const result = await agent({ model }).execute("go", {
      output: summarySchema,
    });

    expect(result.error?.message).toContain("missing summary field");
    expect(result.report.trips).toHaveLength(1);
    expect(model.callCount).toBe(1);
  });

  // 35. Repair: also recovers from unparseable JSON (not just validation)
  it("repairs unparseable JSON output, not only schema validation failures", async () => {
    const mock = MockSDK({
      responses: [
        { content: "totally not json", finishReason: "stop" },
        { content: '{"summary":"fixed"}', finishReason: "stop" },
      ],
    });
    const model: MockModel = mock.model({ name: "mock" }) as MockModel;

    const result = await agent({ model }).execute("go", {
      output: summarySchema,
      repair: { maxAttempts: 1 },
    });

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ summary: "fixed" });
    expect(result.report.trips).toHaveLength(2);
  });

  // 36b. Attachments: image URL becomes a multipart user message
  it("forwards a remote image attachment as a multipart user message", async () => {
    const mock = MockSDK({
      responses: [{ content: "It's a cat", finishReason: "stop" }],
      capabilities: { vision: true },
    });
    const model: MockModel = mock.model({ name: "mock" }) as MockModel;

    await agent({ model }).execute("What's in this?", {
      attachments: ["https://cdn.example.com/cat.png"],
    });

    const userMessage = model.callHistory[0].messages.find((m) => m.role === "user");
    expect(Array.isArray(userMessage?.content)).toBe(true);
    expect(userMessage?.content).toEqual([
      { type: "text", text: "What's in this?" },
      { type: "image", source: { url: "https://cdn.example.com/cat.png" } },
    ]);
  });

  // 36c. Attachments: throws when model lacks vision capability
  it("throws via result.error when image attachments are passed to a non-vision model", async () => {
    const mock = MockSDK({
      responses: [{ content: "ignored", finishReason: "stop" }],
    });
    const model: MockModel = mock.model({ name: "no-vision" }) as MockModel;

    const result = await agent({ model }).execute("look", {
      attachments: ["https://cdn.example.com/cat.png"],
    });

    expect(result.error?.message).toContain('Model "no-vision" does not declare vision');
    expect(result.error?.code).toBe("PROVIDER_INVALID_REQUEST");
    expect(model.callCount).toBe(0);
  });

  // 36d. Attachments: plain string content is preserved when none provided
  it("keeps user message content as a plain string when no attachments are passed", async () => {
    const mock = MockSDK({
      responses: [{ content: "ok", finishReason: "stop" }],
    });
    const model: MockModel = mock.model({ name: "mock" }) as MockModel;

    await agent({ model }).execute("just text");

    const userMessage = model.callHistory[0].messages.find((m) => m.role === "user");
    expect(userMessage?.content).toBe("just text");
  });

  // 36. Repair: bounded by maxTrips — won't exceed the trip cap
  it("respects maxTrips even when repair attempts remain", async () => {
    const mock = MockSDK({
      responses: [
        { content: '{"wrong":"a"}', finishReason: "stop" },
        { content: '{"wrong":"b"}', finishReason: "stop" },
      ],
    });
    const model: MockModel = mock.model({ name: "mock" }) as MockModel;

    const result = await agent({ model, maxTrips: 1 }).execute("go", {
      output: summarySchema,
      repair: { maxAttempts: 5 },
    });

    expect(result.error?.message).toContain("missing summary field");
    expect(result.report.trips).toHaveLength(1);
    expect(model.callCount).toBe(1);
  });

  // 37. Trip input tracking: first trip = user input, subsequent = "[tool results]"
  it("records the original input on trip 0 and a tool-results placeholder on later trips", async () => {
    const echoTool = tool({
      name: "echo",
      description: "echo",
      input: stringSchema,
      execute: async (value) => value,
    });

    const mock = MockSDK({
      responses: [
        {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "call_1", name: "echo", input: "ping" }],
        },
        { content: "All done.", finishReason: "stop" },
      ],
    });
    const model = mock.model({ name: "mock" });

    const result = await agent({ model, tools: [echoTool] }).execute("Original user prompt");

    expect(result.report.trips).toHaveLength(2);
    expect(result.report.trips[0].input).toBe("Original user prompt");
    expect(result.report.trips[1].input).toBe("[tool results]");
  });

  // 38. Structured output: responseSchema forwarded on EVERY trip, not just the first
  it("forwards responseSchema on every trip including post-tool-call trips", async () => {
    const schemaWithJsonSchema: StandardSchemaV1<{ summary: string }> & {
      jsonSchema: Record<string, unknown>;
    } = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (v) =>
          typeof v === "object" && v !== null && "summary" in v
            ? { value: v as { summary: string } }
            : { issues: [{ message: "bad" }] },
      },
      jsonSchema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
    };

    const echoTool = tool({
      name: "echo",
      description: "echo",
      input: stringSchema,
      execute: async (value) => value,
    });

    const mock = MockSDK({
      responses: [
        {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "call_1", name: "echo", input: "ping" }],
        },
        { content: '{"summary":"final"}', finishReason: "stop" },
      ],
    });
    const model: MockModel = mock.model({ name: "mock" }) as MockModel;

    await agent({ model, tools: [echoTool] }).execute("hi", {
      output: schemaWithJsonSchema,
    });

    expect(model.callHistory).toHaveLength(2);
    expect(model.callHistory[0].options?.responseSchema).toEqual(schemaWithJsonSchema.jsonSchema);
    expect(model.callHistory[1].options?.responseSchema).toEqual(schemaWithJsonSchema.jsonSchema);
  });

  // 39. Tool result message preserves the tool_call_id from the model's request
  it("preserves toolCallId on tool-result messages so the model can match them", async () => {
    const echoTool = tool({
      name: "echo",
      description: "echo",
      input: stringSchema,
      execute: async (value) => `echoed: ${value}`,
    });

    const mock = MockSDK({
      responses: [
        {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [
            { id: "call_alpha", name: "echo", input: "first" },
            { id: "call_beta", name: "missing", input: "second" },
          ],
        },
        { content: "ack", finishReason: "stop" },
      ],
    });
    const model: MockModel = mock.model({ name: "mock" }) as MockModel;

    await agent({ model, tools: [echoTool] }).execute("go");

    const secondTripMessages = model.callHistory[1].messages;
    const toolResultMessages = secondTripMessages.filter((m) => m.role === "tool");

    expect(toolResultMessages).toHaveLength(2);
    expect(toolResultMessages[0].toolCallId).toBe("call_alpha");
    expect(toolResultMessages[0].content).toContain("echoed: first");
    // Unregistered-tool branch must also preserve the id
    expect(toolResultMessages[1].toolCallId).toBe("call_beta");
    expect(toolResultMessages[1].content).toContain("Tool not registered");
  });

  // 40. Structured-output instruction: appended to systemPrompt with exact blank-line separator
  it("appends the JSON-only instruction to systemPrompt with a blank line between them", async () => {
    const mock = MockSDK({
      responses: [{ content: '{"summary":"x"}', finishReason: "stop" }],
    });
    const model: MockModel = mock.model({ name: "mock" }) as MockModel;

    await agent({ model, systemPrompt: "Be concise." }).execute("hi", {
      output: summarySchema,
    });

    const systemContent = model.callHistory[0].messages[0].content as string;

    // Original systemPrompt comes first, then exactly one blank line, then the JSON instruction
    expect(systemContent.startsWith("Be concise.\n\n")).toBe(true);
    expect(systemContent).toContain("You MUST respond with a single valid JSON value only.");
    // No triple-newline between the two — exactly "\n\n"
    expect(systemContent).not.toMatch(/Be concise\.\n\n\n/);
  });

  // 40b. Structured-output instruction: appended alone when no systemPrompt is configured
  it("uses the JSON-only instruction as the entire system message when no systemPrompt is set", async () => {
    const mock = MockSDK({
      responses: [{ content: '{"summary":"x"}', finishReason: "stop" }],
    });
    const model: MockModel = mock.model({ name: "mock" }) as MockModel;

    await agent({ model }).execute("hi", { output: summarySchema });

    const systemMessage = model.callHistory[0].messages[0];

    expect(systemMessage.role).toBe("system");
    expect(systemMessage.content).toMatch(
      /^You MUST respond with a single valid JSON value only\./,
    );
    // Should NOT start with a blank line — no empty systemPrompt prefix leaked through
    expect((systemMessage.content as string).startsWith("\n")).toBe(false);
  });

  // 41a. Repair message ordering: bad assistant response, then user correction message
  it("appends repair messages in order: assistant(bad response), user(correction with reason)", async () => {
    const mock = MockSDK({
      responses: [
        { content: '{"wrong":"value"}', finishReason: "stop" },
        { content: '{"summary":"recovered"}', finishReason: "stop" },
      ],
    });
    const model: MockModel = mock.model({ name: "mock" }) as MockModel;

    await agent({ model }).execute("go", {
      output: summarySchema,
      repair: { maxAttempts: 1 },
    });

    // Second call's messages include the repair pair
    const secondCallMessages = model.callHistory[1].messages;
    const repairAssistant = secondCallMessages[secondCallMessages.length - 2];
    const repairUser = secondCallMessages[secondCallMessages.length - 1];

    expect(repairAssistant.role).toBe("assistant");
    expect(repairAssistant.content).toBe('{"wrong":"value"}');

    expect(repairUser.role).toBe("user");
    expect(repairUser.content).toContain("Your previous response failed validation:");
    expect(repairUser.content).toContain("missing summary field");
    expect(repairUser.content).toContain("Respond again with valid JSON only");
  });

  // 41b. parseOutput skipped when a prior trip-level error is already set (not repairable)
  it("skips output parsing and repair when a prior trip-level error already populated result.error", async () => {
    const mock = MockSDK({
      responses: [{ content: "", error: new Error("upstream model failure") }],
    });
    const model: MockModel = mock.model({ name: "mock" }) as MockModel;

    const result = await agent({ model }).execute("go", {
      output: summarySchema,
      repair: { maxAttempts: 3 },
    });

    expect(result.error?.message).toBe("upstream model failure");
    // No repair attempts triggered — exactly the one failed call happened
    expect(model.callCount).toBe(1);
    expect(result.data).toBeUndefined();
  });

  // 42. Streaming: delta concatenation reproduces the model's content exactly
  it("accumulates streamed delta content into result.text matching the joined deltas", async () => {
    const mock = MockSDK({
      responses: [{ content: "one two three four five", finishReason: "stop" }],
    });
    const model = mock.model({ name: "mock" });

    const stream = agent({ model }).stream("go");
    const deltas: string[] = [];

    for await (const event of stream) {
      if (event.type === "agent.trip.streaming") {
        deltas.push(event.delta);
      }
    }

    const result = await stream.result;

    // More than one delta arrived (would catch a regression that bundled into one)
    expect(deltas.length).toBeGreaterThan(1);
    // Concatenation of every emitted delta equals the final text the agent reports
    expect(deltas.join("")).toBe(result.text);
    // And reproduces every word from the source content
    for (const word of ["one", "two", "three", "four", "five"]) {
      expect(result.text).toContain(word);
    }
  });
});
