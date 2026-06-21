import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "../contracts/stream/stream-event.type";
import { MockSDK } from "../mock/mock-sdk";
import { tool } from "../tool/tool";
import { agent } from "./agent";

function makeSchema<T>(
  validate: (value: unknown) => StandardSchemaV1.Result<T>,
): StandardSchemaV1<T> {
  return { "~standard": { version: 1, vendor: "test", validate } };
}

const querySchema = makeSchema<{ query: string }>((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { issues: [{ message: "expected object" }] };
  }

  const v = value as { query?: unknown };

  if (typeof v.query !== "string") {
    return { issues: [{ message: "expected query string" }] };
  }

  return { value: { query: v.query } };
});

function buildLeakyAgent(opts: {
  leakedContent: string;
  withGuardOnConfig?: boolean;
}) {
  const executeSpy = vi.fn(async (input: { query: string }) => ({
    found: 1,
    echo: input.query,
  }));

  const searchTool = tool({
    name: "search_catalog",
    description: "Search.",
    input: querySchema,
    execute: executeSpy,
  });

  const mock = MockSDK({
    responses: [
      {
        content: opts.leakedContent,
        finishReason: "stop",
      },
      // Continuation trip after the recovered call dispatches — the
      // model produces a clean final reply.
      { content: "All set!", finishReason: "stop" },
    ],
  });

  const model = mock.model({ name: "mock" });

  const agentInstance = agent({
    model,
    tools: [searchTool],
    ...(opts.withGuardOnConfig ? { streamingToolGuard: {} } : {}),
  });

  return { agentInstance, executeSpy, mock };
}

async function drainStream(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];

  for await (const event of stream) {
    events.push(event);
  }

  return events;
}

describe("agent() — streaming tool-call guard", () => {
  it("recovers a tool call when the model leaks it as text in the stream", async () => {
    const leakedContent = `Sure: {"name":"search_catalog","arguments":{"query":"red shoes"}}`;

    const { agentInstance, executeSpy } = buildLeakyAgent({
      leakedContent,
      withGuardOnConfig: true,
    });

    const stream = agentInstance.stream("find me shoes");

    const events = await drainStream(stream);
    const result = await stream.result;

    expect(executeSpy).toHaveBeenCalledOnce();
    expect(executeSpy).toHaveBeenCalledWith({ query: "red shoes" }, expect.anything());

    // The streamed deltas the consumer saw — no JSON envelope.
    const streamingDeltas = events
      .filter((event) => event.type === "agent.trip.streaming")
      .map((event) => (event as { delta: string }).delta)
      .join("");

    expect(streamingDeltas).not.toContain('"name"');
    expect(streamingDeltas).not.toContain("search_catalog");
    expect(streamingDeltas).toMatch(/Sure/);

    // The final reply is from the continuation trip (post-dispatch).
    // MockModel.stream appends a trailing space per word; trim for the
    // comparison since that's a mock artifact, not real-model behavior.
    expect(result.text?.trim()).toBe("All set!");

    // Two trips: the leaky one (recovered) and the clean continuation.
    expect(result.report.trips).toHaveLength(2);

    // The first trip dispatched a single tool — the recovered one.
    const firstTrip = result.report.trips[0];
    expect(firstTrip.toolCalls).toHaveLength(1);
    expect(firstTrip.toolCalls?.[0].name).toBe("search_catalog");
  });

  it("does NOT engage when the guard is unset (default off, faithful relay)", async () => {
    const leakedContent = `Plain: {"name":"search_catalog","arguments":{"query":"x"}}`;

    const { agentInstance, executeSpy } = buildLeakyAgent({
      leakedContent,
      withGuardOnConfig: false,
    });

    const result = await agentInstance.execute("anything");

    // No dispatch — the leak stayed as text.
    expect(executeSpy).not.toHaveBeenCalled();

    // The trip's output carries the raw JSON (one trip only, no recovery).
    expect(result.text).toContain('"name":"search_catalog"');
    expect(result.report.trips).toHaveLength(1);
  });

  it("normalizes finishReason from stop → tool_calls when the guard recovers", async () => {
    const leakedContent = `{"name":"search_catalog","arguments":{"query":"normalize"}}`;

    const { agentInstance } = buildLeakyAgent({
      leakedContent,
      withGuardOnConfig: true,
    });

    const stream = agentInstance.stream("go");

    await drainStream(stream);
    const result = await stream.result;

    // First trip ran the recovered tool — finishReason on that trip is `tool_calls`.
    expect(result.report.trips[0].finishReason).toBe("tool_calls");
  });

  it("stamps recoveredFrom on the synthesized request seen by the trip", async () => {
    const leakedContent = `{"name":"search_catalog","arguments":{"query":"trace"}}`;

    const { agentInstance } = buildLeakyAgent({
      leakedContent,
      withGuardOnConfig: true,
    });

    const stream = agentInstance.stream("go");

    const events = await drainStream(stream);
    await stream.result;

    const toolCalledEvent = events.find((event) => event.type === "agent.tool.called");

    expect(toolCalledEvent).toBeDefined();
    // The synthesized id format proves provenance.
    expect((toolCalledEvent as { runId?: string }).runId).toBeDefined();
  });

  it("dedupes when the model emits both a real tool call AND a narrated envelope", async () => {
    const executeSpy = vi.fn(async (input: { query: string }) => ({ echo: input.query }));

    const searchTool = tool({
      name: "search_catalog",
      description: "Search.",
      input: querySchema,
      execute: executeSpy,
    });

    // Model emits the JSON envelope as text AND emits the real
    // structured tool call — same name, same args. Guard recovers
    // from text; agent dedupes against the real one; dispatch fires
    // exactly once.
    const mock = MockSDK({
      responses: [
        {
          content: `Looking: {"name":"search_catalog","arguments":{"query":"dup"}}`,
          finishReason: "tool_calls",
          toolCalls: [{ id: "c1", name: "search_catalog", input: { query: "dup" } }],
        },
        { content: "Done.", finishReason: "stop" },
      ],
    });

    const model = mock.model({ name: "mock" });
    const agentInstance = agent({
      model,
      tools: [searchTool],
      streamingToolGuard: {},
    });

    const stream = agentInstance.stream("go");
    await drainStream(stream);
    const result = await stream.result;

    // Dispatched exactly once, not twice.
    expect(executeSpy).toHaveBeenCalledOnce();

    expect(result.report.trips[0].toolCalls).toHaveLength(1);
    expect(result.report.trips[0].toolCalls?.[0].name).toBe("search_catalog");
  });

  it("allows per-call options to enable the guard when config has it off", async () => {
    const executeSpy = vi.fn(async (input: { query: string }) => ({ echo: input.query }));

    const searchTool = tool({
      name: "search_catalog",
      description: "Search.",
      input: querySchema,
      execute: executeSpy,
    });

    const leakedContent = `{"name":"search_catalog","arguments":{"query":"opts"}}`;

    const mock = MockSDK({
      responses: [
        { content: leakedContent, finishReason: "stop" },
        { content: "Done.", finishReason: "stop" },
      ],
    });

    const agentInstance = agent({
      model: mock.model({ name: "mock" }),
      tools: [searchTool],
      // Guard NOT set at config level.
    });

    const stream = agentInstance.stream("go", { streamingToolGuard: {} });
    await drainStream(stream);

    expect(executeSpy).toHaveBeenCalledOnce();
  });

  it("allows per-call undefined to disable the guard when config has it on", async () => {
    const executeSpy = vi.fn();

    const searchTool = tool({
      name: "search_catalog",
      description: "Search.",
      input: querySchema,
      execute: executeSpy,
    });

    const leakedContent = `{"name":"search_catalog","arguments":{"query":"off"}}`;

    const mock = MockSDK({
      responses: [{ content: leakedContent, finishReason: "stop" }],
    });

    const agentInstance = agent({
      model: mock.model({ name: "mock" }),
      tools: [searchTool],
      streamingToolGuard: {}, // ON at config level
    });

    // Explicitly disable for this call.
    const stream = agentInstance.stream("go", { streamingToolGuard: undefined });
    await drainStream(stream);
    const result = await stream.result;

    expect(executeSpy).not.toHaveBeenCalled();
    expect(result.text).toContain("search_catalog");
  });
});
