import type { StandardSchemaV1 } from "@standard-schema/spec";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentReport } from "../contracts/result/execution-report.type";
import type { ExecutionReport } from "../contracts/result/execution-report.type";
import { MockSDK } from "../mock/mock-sdk";
import {
  clearObservers,
  registerObserver,
  setObserveAll,
} from "../observe/observer-registry";
import type { Observer } from "../observe/observer.contract";
import { tool } from "../tool/tool";
import { agent } from "./agent";

// Hand-rolled Standard Schema (mirrors agent.spec.ts).
function makeSchema<T>(
  validate: (value: unknown) => StandardSchemaV1.Result<T>,
): StandardSchemaV1<T> {
  return { "~standard": { version: 1, vendor: "test", validate } };
}

const stringSchema = makeSchema<string>((v) =>
  typeof v === "string" ? { value: v } : { issues: [{ message: "expected string" }] },
);

/** A fake observer that records every report handed to it. */
function makeFakeObserver(): Observer & { collected: ExecutionReport[] } {
  const collected: ExecutionReport[] = [];

  return {
    collected,
    collect(report) {
      collected.push(report);
    },
  };
}

/** Scripted echo tool used to force multi-trip tool runs. */
function echoTool() {
  return tool({
    name: "echo",
    description: "Echo",
    input: stringSchema,
    execute: async (s: string) => s,
  });
}

describe("agent — F2 captureMessages", () => {
  afterEach(() => {
    clearObservers();
  });

  it("emits AgentReport.messages with every role across a multi-trip tool run", async () => {
    const mock = MockSDK({
      responses: [
        {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "call_1", name: "echo", input: "hi" }],
        },
        { content: "All done.", finishReason: "stop" },
      ],
    });
    const model = mock.model({ name: "mock" });

    const result = await agent({
      model,
      systemPrompt: "You are a helper.",
      tools: [echoTool()],
      captureMessages: true,
    }).execute("Go");

    const report = result.report as AgentReport;
    const messages = report.messages;

    expect(messages).toBeDefined();
    const roles = messages!.map((m) => m.role);

    // system (from systemPrompt) + user input + assistant tool-call turn
    // + tool-result turn + final assistant turn.
    expect(roles).toContain("system");
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    expect(roles).toContain("tool");

    // The assistant tool-call turn carries the toolCalls; the tool-result
    // turn carries the toolCallId linking back to it.
    const assistantWithCalls = messages!.find(
      (m) => m.role === "assistant" && m.toolCalls !== undefined,
    );
    expect(assistantWithCalls?.toolCalls?.[0]?.name).toBe("echo");

    const toolResult = messages!.find((m) => m.role === "tool");
    expect(toolResult?.toolCallId).toBe("call_1");
  });

  it("omits AgentReport.messages entirely when captureMessages is off", async () => {
    const mock = MockSDK({
      responses: [{ content: "ok", finishReason: "stop" }],
    });
    const model = mock.model({ name: "mock" });

    const result = await agent({ model, systemPrompt: "Hi" }).execute("ping");

    const report = result.report as AgentReport;
    expect(report.messages).toBeUndefined();
    // Confirm the gate is byte-for-byte additive: the key isn't present.
    expect("messages" in report).toBe(false);
  });

  it("captures content as strings (tool results stringified)", async () => {
    const mock = MockSDK({
      responses: [
        {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "c1", name: "echo", input: "payload" }],
        },
        { content: "done", finishReason: "stop" },
      ],
    });
    const model = mock.model({ name: "mock" });

    const result = await agent({
      model,
      tools: [echoTool()],
      captureMessages: true,
    }).execute("Go");

    const report = result.report as AgentReport;
    for (const message of report.messages ?? []) {
      expect(typeof message.content).toBe("string");
    }
  });
});

describe("agent — F1/F3 observe routing", () => {
  afterEach(() => {
    clearObservers();
  });

  it("observe:true routes the report to a registered observer", async () => {
    const observer = makeFakeObserver();
    registerObserver(observer);

    const mock = MockSDK({ responses: [{ content: "ok", finishReason: "stop" }] });
    const model = mock.model({ name: "mock" });

    const result = await agent({ model, observe: true }).execute("ping");

    expect(observer.collected).toHaveLength(1);
    expect(observer.collected[0]).toBe(result.report);
  });

  it("observe:false opts out even when observeAll is on", async () => {
    const observer = makeFakeObserver();
    registerObserver(observer);
    setObserveAll(true);

    const mock = MockSDK({ responses: [{ content: "ok", finishReason: "stop" }] });
    const model = mock.model({ name: "mock" });

    await agent({ model, observe: false }).execute("ping");

    expect(observer.collected).toHaveLength(0);
  });

  it("observe:<fakeObserver> routes only to that flow-local observer", async () => {
    const global = makeFakeObserver();
    const local = makeFakeObserver();
    registerObserver(global);

    const mock = MockSDK({ responses: [{ content: "ok", finishReason: "stop" }] });
    const model = mock.model({ name: "mock" });

    const result = await agent({ model, observe: local }).execute("ping");

    expect(local.collected).toEqual([result.report]);
    expect(global.collected).toHaveLength(0);
  });

  it("observeAll routes the report by default (no per-flow observe set)", async () => {
    const observer = makeFakeObserver();
    registerObserver(observer);
    setObserveAll(true);

    const mock = MockSDK({ responses: [{ content: "ok", finishReason: "stop" }] });
    const model = mock.model({ name: "mock" });

    await agent({ model }).execute("ping");

    expect(observer.collected).toHaveLength(1);
  });

  it("does nothing by default when neither observe nor observeAll is set", async () => {
    const observer = makeFakeObserver();
    registerObserver(observer);

    const mock = MockSDK({ responses: [{ content: "ok", finishReason: "stop" }] });
    const model = mock.model({ name: "mock" });

    await agent({ model }).execute("ping");

    expect(observer.collected).toHaveLength(0);
  });

  it("swallows observer errors (never breaks the run)", async () => {
    const throwing: Observer = {
      collect() {
        throw new Error("observer boom");
      },
    };
    registerObserver(throwing);

    const mock = MockSDK({ responses: [{ content: "ok", finishReason: "stop" }] });
    const model = mock.model({ name: "mock" });

    const result = await agent({ model, observe: true }).execute("ping");

    // The run completes normally despite the observer throwing.
    expect(result.error).toBeUndefined();
    expect(result.text).toBe("ok");
  });
});
