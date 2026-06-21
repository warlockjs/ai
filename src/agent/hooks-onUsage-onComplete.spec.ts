import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it, vi } from "vitest";
import type { CompleteEvent } from "../contracts/events/complete-event.type";
import type { UsageEvent } from "../contracts/events/usage-event.type";
import { MockSDK } from "../mock/mock-sdk";
import { tool } from "../tool/tool";
import { agent } from "./agent";

function makeSchema<T>(
  validate: (value: unknown) => StandardSchemaV1.Result<T>,
): StandardSchemaV1<T> {
  return { "~standard": { version: 1, vendor: "test", validate } };
}

const stringSchema = makeSchema<string>((v) =>
  typeof v === "string" ? { value: v } : { issues: [{ message: "expected string" }] },
);

describe("agent() — onUsage + onComplete hooks", () => {
  // 1. onUsage fires once per LLM trip with stable identity.
  it("fires onUsage once per trip with runId + tripIndex + model identity", async () => {
    const seen: UsageEvent[] = [];

    const echoTool = tool({
      name: "echo",
      description: "Echo",
      input: stringSchema,
      execute: async (s: string) => `result:${s}`,
    });

    const mock = MockSDK({
      responses: [
        {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "c1", name: "echo", input: "hi" }],
          usage: { input: 10, output: 5, total: 15 },
        },
        {
          content: "Done.",
          finishReason: "stop",
          usage: { input: 20, output: 8, total: 28 },
        },
      ],
    });
    const model = mock.model({ name: "mock" });

    const result = await agent({
      model,
      tools: [echoTool],
      onUsage: (event) => {
        seen.push(event);
      },
    }).execute("Use echo");

    // Two trips → two usage events.
    expect(seen).toHaveLength(2);

    // Trip 0 — initial trip.
    expect(seen[0].tripIndex).toBe(0);
    expect(seen[0].runId).toBe(result.report.runId);
    expect(seen[0].model.name).toBe("mock");
    expect(seen[0].usage.input).toBe(10);
    expect(seen[0].usage.output).toBe(5);
    expect(typeof seen[0].timestamp).toBe("string");

    // Trip 1 — continuation after tool result.
    expect(seen[1].tripIndex).toBe(1);
    expect(seen[1].runId).toBe(result.report.runId);
    expect(seen[1].usage.input).toBe(20);
    expect(seen[1].usage.output).toBe(8);
  });

  // 2. onComplete fires once per execution with the full result.
  it("fires onComplete once per execution with runId + durationMs", async () => {
    const seen: CompleteEvent<unknown>[] = [];

    const mock = MockSDK({
      responses: [{ content: "Hello", finishReason: "stop" }],
    });
    const model = mock.model({ name: "mock" });

    const result = await agent({
      model,
      onComplete: (event) => {
        seen.push(event);
      },
    }).execute("Hi");

    expect(seen).toHaveLength(1);
    expect(seen[0].runId).toBe(result.report.runId);
    expect(seen[0].result).toBe(result);
    expect(typeof seen[0].durationMs).toBe("number");
    expect(seen[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  // 3. Hook errors are swallowed — agent loop is unaffected.
  it("swallows errors thrown inside onUsage and onComplete", async () => {
    const mock = MockSDK({
      responses: [{ content: "Reply", finishReason: "stop" }],
    });
    const model = mock.model({ name: "mock" });

    const result = await agent({
      model,
      onUsage: () => {
        throw new Error("synthetic onUsage failure");
      },
      onComplete: () => {
        throw new Error("synthetic onComplete failure");
      },
    }).execute("Hi");

    // The agent run completed normally despite both hooks throwing.
    expect(result.text).toBe("Reply");
    expect(result.error).toBeUndefined();
  });

  // 4. Async hooks are awaited — sync-after-await ordering preserved.
  it("awaits async onUsage handlers", async () => {
    const order: string[] = [];

    const mock = MockSDK({
      responses: [{ content: "Ok", finishReason: "stop" }],
    });
    const model = mock.model({ name: "mock" });

    await agent({
      model,
      onUsage: async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push("onUsage-async-resolved");
      },
      onComplete: () => {
        order.push("onComplete-fired");
      },
    }).execute("Go");

    // onUsage's async work must finish before onComplete fires.
    expect(order).toEqual(["onUsage-async-resolved", "onComplete-fired"]);
  });

  // 5. Cached tokens propagate through the usage event when the
  //    underlying ModelResponse carries them.
  it("propagates cachedTokens from response.usage into the UsageEvent", async () => {
    const seen: UsageEvent[] = [];

    const mock = MockSDK({
      responses: [
        {
          content: "Cached",
          finishReason: "stop",
          usage: { input: 100, output: 20, total: 120, cachedTokens: 80 },
        },
      ],
    });
    const model = mock.model({ name: "mock" });

    await agent({
      model,
      onUsage: (event) => {
        seen.push(event);
      },
    }).execute("Hi");

    expect(seen).toHaveLength(1);
    expect(seen[0].usage.cachedTokens).toBe(80);
  });

  // 6. onComplete fires even on cancelled / failed runs.
  it("fires onComplete with result.error populated when run is cancelled", async () => {
    const seen: CompleteEvent<unknown>[] = [];
    const controller = new AbortController();
    controller.abort();

    const mock = MockSDK({
      responses: [{ content: "should not stream", finishReason: "stop" }],
    });
    const model = mock.model({ name: "mock" });

    const result = await agent({
      model,
      onComplete: (event) => {
        seen.push(event);
      },
    }).execute("Go", { signal: controller.signal });

    expect(seen).toHaveLength(1);
    expect(seen[0].result).toBe(result);
    expect(result.error).toBeDefined();
    expect(result.report.status).toBe("cancelled");
  });
});
