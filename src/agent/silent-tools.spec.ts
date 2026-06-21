import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it, vi } from "vitest";
import type { ToolCall } from "../contracts/result/tool-call.type";
import { MockSDK } from "../mock/mock-sdk";
import { tool } from "../tool/tool";
import { agent } from "./agent";

// Hand-rolled string schema (mirrors agent.spec.ts).
function makeSchema<T>(
  validate: (value: unknown) => StandardSchemaV1.Result<T>,
): StandardSchemaV1<T> {
  return { "~standard": { version: 1, vendor: "test", validate } };
}

const stringSchema = makeSchema<string>((v) =>
  typeof v === "string" ? { value: v } : { issues: [{ message: "expected string" }] },
);

describe("agent() — silent-mode tools", () => {
  // 1. Single silent tool → single trip, no continuation.
  it("terminates after dispatch when the only tool call is silent", async () => {
    const executeSpy = vi.fn(async (_: string) => "ok");

    const silentTool = tool({
      name: "set_state",
      description: "Pure side-effect.",
      input: stringSchema,
      mode: "silent",
      execute: executeSpy,
    });

    const mock = MockSDK({
      responses: [
        {
          content: "Got it, locale pinned to Arabic.",
          finishReason: "tool_calls",
          toolCalls: [{ id: "c1", name: "set_state", input: "ar" }],
        },
        // Sentinel — should NEVER be consumed. If the loop continues,
        // this trip would fire and the test would catch it via call count.
        { content: "should not reach", finishReason: "stop" },
      ],
    });
    const model = mock.model({ name: "mock" });

    const result = await agent({ model, tools: [silentTool] }).execute("set ar");

    // Tool ran exactly once.
    expect(executeSpy).toHaveBeenCalledOnce();

    // Only ONE LLM trip — the second mock response was never consumed.
    expect(result.report.trips).toHaveLength(1);

    // The prose alongside the tool call IS the final reply.
    expect(result.text).toBe("Got it, locale pinned to Arabic.");

    // ToolCall record still produced.
    expect(result.report.children).toHaveLength(1);
    expect(result.report.children[0].name).toBe("set_state");
  });

  // 2. Mixed trip (silent + feedback) → continues to second trip.
  it("continues the loop when silent and feedback tools are mixed in one trip", async () => {
    const silentTool = tool({
      name: "set_state",
      description: "Side-effect.",
      input: stringSchema,
      mode: "silent",
      execute: async () => "ok",
    });

    const feedbackTool = tool({
      name: "search",
      description: "Returns data the model needs.",
      input: stringSchema,
      execute: async () => "search-result",
    });

    const mock = MockSDK({
      responses: [
        {
          content: "Looking it up...",
          finishReason: "tool_calls",
          toolCalls: [
            { id: "c1", name: "set_state", input: "topic-set" },
            { id: "c2", name: "search", input: "query" },
          ],
        },
        {
          content: "Here's what I found.",
          finishReason: "stop",
        },
      ],
    });
    const model = mock.model({ name: "mock" });

    const result = await agent({ model, tools: [silentTool, feedbackTool] }).execute("mix");

    // Two trips — feedback tool's result HAS to round-trip.
    expect(result.report.trips).toHaveLength(2);

    // Final reply is the second trip's content.
    expect(result.text).toBe("Here's what I found.");

    // Both tools dispatched.
    expect(result.report.children).toHaveLength(2);
    const toolNames = result.report.children.map((c) => c.name).sort();
    expect(toolNames).toEqual(["search", "set_state"]);
  });

  // 3. Multiple silent calls in one trip → still single trip.
  it("terminates after dispatch when all N tool calls are silent", async () => {
    const executeSpy = vi.fn(async (_: string) => "ok");

    const silentTool = tool({
      name: "log_event",
      description: "Telemetry ping.",
      input: stringSchema,
      mode: "silent",
      execute: executeSpy,
    });

    const mock = MockSDK({
      responses: [
        {
          content: "Tracked.",
          finishReason: "tool_calls",
          toolCalls: [
            { id: "c1", name: "log_event", input: "view" },
            { id: "c2", name: "log_event", input: "click" },
            { id: "c3", name: "log_event", input: "scroll" },
          ],
        },
        { content: "should not reach", finishReason: "stop" },
      ],
    });
    const model = mock.model({ name: "mock" });

    const result = await agent({ model, tools: [silentTool] }).execute("track");

    expect(executeSpy).toHaveBeenCalledTimes(3);
    expect(result.report.trips).toHaveLength(1);
    expect(result.text).toBe("Tracked.");
    expect(result.report.children).toHaveLength(3);
  });

  // 4. Default-mode (no `mode` field) tools behave exactly as before — regression guard.
  it("preserves feedback-mode behavior for tools without a `mode` field", async () => {
    const feedbackTool = tool({
      name: "echo",
      description: "Echoes input.",
      input: stringSchema,
      execute: async (s: string) => s,
    });

    const mock = MockSDK({
      responses: [
        {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "c1", name: "echo", input: "ping" }],
        },
        { content: "Done.", finishReason: "stop" },
      ],
    });
    const model = mock.model({ name: "mock" });

    const result = await agent({ model, tools: [feedbackTool] }).execute("go");

    // Two trips — the absence of `mode` is treated as "feedback".
    expect(result.report.trips).toHaveLength(2);
    expect(result.text).toBe("Done.");
  });

  // 5. Middleware sees the tool's `mode` so cost/telemetry can branch.
  it("exposes `mode` on MiddlewareToolContext.tool", async () => {
    const observed: Array<string | undefined> = [];

    const silentTool = tool({
      name: "set_state",
      description: "Side-effect.",
      input: stringSchema,
      mode: "silent",
      execute: async () => "ok",
    });

    const feedbackTool = tool({
      name: "echo",
      description: "Echo.",
      input: stringSchema,
      execute: async (s: string) => s,
    });

    const mock = MockSDK({
      responses: [
        {
          content: "Working...",
          finishReason: "tool_calls",
          toolCalls: [
            { id: "c1", name: "set_state", input: "x" },
            { id: "c2", name: "echo", input: "y" },
          ],
        },
        { content: "Done.", finishReason: "stop" },
      ],
    });
    const model = mock.model({ name: "mock" });

    await agent({
      model,
      tools: [silentTool, feedbackTool],
      middleware: [
        {
          name: "mode-spy",
          tool: {
            before(ctx) {
              observed.push(ctx.tool.mode);
            },
          },
        },
      ],
    }).execute("mix");

    expect(observed).toContain("silent");
    expect(observed).toContain(undefined);
  });
});

// Type-level regression: existing tools without `mode` still satisfy
// the contract. If `mode` ever becomes required, this fails to compile.
type _ContractStillAcceptsToolsWithoutMode = ReturnType<
  typeof tool<string, string>
>;
const _typeOnly: _ContractStillAcceptsToolsWithoutMode = tool({
  name: "no-mode",
  description: "x",
  input: stringSchema,
  execute: async (s: string) => s,
});
void _typeOnly;
