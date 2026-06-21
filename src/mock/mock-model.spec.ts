import { describe, expect, it } from "vitest";
import type { Message } from "../contracts/conversation-message.type";
import type { ModelStreamChunk } from "../contracts/model.contract";
import { MockModel } from "./mock-model";

const userMessage: Message[] = [{ role: "user", content: "hi" }];

/** Drain an async iterable of stream chunks into an array. */
async function collect(
  stream: AsyncIterable<ModelStreamChunk>,
): Promise<ModelStreamChunk[]> {
  const chunks: ModelStreamChunk[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return chunks;
}

describe("MockModel — identity", () => {
  it("reports provider 'mock' and the supplied name", () => {
    const model = new MockModel("mock-gpt", []);

    expect(model.provider).toBe("mock");
    expect(model.name).toBe("mock-gpt");
  });

  it("exposes the capabilities passed to the constructor", () => {
    const model = new MockModel("m", [], { vision: true });

    expect(model.capabilities).toEqual({ vision: true });
  });

  it("leaves capabilities undefined when none are supplied", () => {
    const model = new MockModel("m", []);

    expect(model.capabilities).toBeUndefined();
  });
});

describe("MockModel.complete — scripted responses", () => {
  it("returns the scripted content and finishReason in order", async () => {
    const model = new MockModel("m", [
      { content: "first", finishReason: "stop" },
      { content: "second", finishReason: "tool_calls" },
    ]);

    const r1 = await model.complete(userMessage);
    const r2 = await model.complete(userMessage);

    expect(r1.content).toBe("first");
    expect(r1.finishReason).toBe("stop");
    expect(r2.content).toBe("second");
    expect(r2.finishReason).toBe("tool_calls");
  });

  it("defaults finishReason to 'stop' when the script omits it", async () => {
    const model = new MockModel("m", [{ content: "hi" }]);

    const result = await model.complete(userMessage);

    expect(result.finishReason).toBe("stop");
  });

  it("passes through scripted toolCalls verbatim", async () => {
    const toolCalls = [{ id: "c1", name: "echo", input: { value: "x" } }];
    const model = new MockModel("m", [
      { content: "", finishReason: "tool_calls", toolCalls },
    ]);

    const result = await model.complete(userMessage);

    expect(result.toolCalls).toEqual(toolCalls);
  });

  it("reuses the final scripted entry once the queue is exhausted", async () => {
    const model = new MockModel("m", [{ content: "only", finishReason: "stop" }]);

    await model.complete(userMessage);
    const overflow = await model.complete(userMessage);

    expect(overflow.content).toBe("only");
  });

  it("falls back to a default response when constructed with an empty queue", async () => {
    const model = new MockModel("m", []);

    const result = await model.complete(userMessage);

    expect(result.content).toBe("Mock response");
    expect(result.finishReason).toBe("stop");
  });
});

describe("MockModel.complete — usage synthesis", () => {
  it("synthesizes usage when the script omits it (input=10, output=ceil(len/4))", async () => {
    // content length 8 → ceil(8/4) = 2 output tokens.
    const model = new MockModel("m", [{ content: "12345678" }]);

    const result = await model.complete(userMessage);

    expect(result.usage.input).toBe(10);
    expect(result.usage.output).toBe(2);
    expect(result.usage.total).toBe(12);
  });

  it("rounds output tokens up for non-multiple-of-four lengths", async () => {
    // length 5 → ceil(5/4) = 2.
    const model = new MockModel("m", [{ content: "12345" }]);

    const result = await model.complete(userMessage);

    expect(result.usage.output).toBe(2);
  });

  it("synthesizes zero output tokens for empty content", async () => {
    const model = new MockModel("m", [{ content: "" }]);

    const result = await model.complete(userMessage);

    expect(result.usage.output).toBe(0);
    expect(result.usage.input).toBe(10);
    expect(result.usage.total).toBe(10);
  });

  it("honors explicit usage from the script over the synthesized estimate", async () => {
    const model = new MockModel("m", [
      {
        content: "hello",
        usage: { input: 100, output: 200, total: 300 },
      },
    ]);

    const result = await model.complete(userMessage);

    expect(result.usage).toMatchObject({ input: 100, output: 200, total: 300 });
  });

  it("recomputes total from explicit input + output (ignores script total)", async () => {
    // Source: total = (usage.input ?? est) + (usage.output ?? est).
    // A mismatched script total is overridden by the recomputed sum.
    const model = new MockModel("m", [
      {
        content: "x",
        usage: { input: 7, output: 3, total: 999 },
      },
    ]);

    const result = await model.complete(userMessage);

    expect(result.usage.total).toBe(10);
  });

  it("includes cachedTokens only when the script supplies it", async () => {
    const withCache = new MockModel("m", [
      { content: "x", usage: { input: 5, output: 5, total: 10, cachedTokens: 2 } },
    ]);
    const withoutCache = new MockModel("m", [{ content: "x" }]);

    const cached = await withCache.complete(userMessage);
    const plain = await withoutCache.complete(userMessage);

    expect(cached.usage.cachedTokens).toBe(2);
    expect(plain.usage).not.toHaveProperty("cachedTokens");
  });
});

describe("MockModel.complete — call recording", () => {
  it("records every call with its messages and options", async () => {
    const model = new MockModel("m", [{ content: "ok" }]);
    const options = { temperature: 0.5 };

    await model.complete(userMessage, options);

    expect(model.callCount).toBe(1);
    expect(model.callHistory).toHaveLength(1);
    expect(model.callHistory[0].messages).toBe(userMessage);
    expect(model.callHistory[0].options).toBe(options);
  });

  it("callCount mirrors callHistory.length across multiple calls", async () => {
    const model = new MockModel("m", [{ content: "ok" }]);

    await model.complete(userMessage);
    await model.complete(userMessage);
    await model.complete(userMessage);

    expect(model.callCount).toBe(3);
    expect(model.callHistory).toHaveLength(3);
  });

  it("records options as undefined when none are passed", async () => {
    const model = new MockModel("m", [{ content: "ok" }]);

    await model.complete(userMessage);

    expect(model.callHistory[0].options).toBeUndefined();
  });
});

describe("MockModel.complete — error + delay", () => {
  it("throws the scripted error instead of returning a response", async () => {
    const boom = new Error("provider down");
    const model = new MockModel("m", [{ content: "", error: boom }]);

    await expect(model.complete(userMessage)).rejects.toBe(boom);
  });

  it("still records the call even when it throws", async () => {
    const model = new MockModel("m", [{ content: "", error: new Error("x") }]);

    await expect(model.complete(userMessage)).rejects.toThrow("x");
    expect(model.callCount).toBe(1);
  });

  it("waits the scripted delay before resolving", async () => {
    const model = new MockModel("m", [{ content: "slow", delay: 30 }]);

    const start = Date.now();
    await model.complete(userMessage);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(25);
  });
});

describe("MockModel.stream", () => {
  it("emits each word as a delta chunk with a trailing space, then a done chunk", async () => {
    const model = new MockModel("m", [
      { content: "hello world", finishReason: "stop" },
    ]);

    const chunks = await collect(model.stream(userMessage));

    expect(chunks).toEqual([
      { type: "delta", content: "hello " },
      { type: "delta", content: "world " },
      {
        type: "done",
        finishReason: "stop",
        usage: { input: 10, output: 3, total: 13 },
      },
    ]);
  });

  it("emits scripted tool calls as tool-call chunks before done", async () => {
    const model = new MockModel("m", [
      {
        content: "calling",
        finishReason: "tool_calls",
        toolCalls: [{ id: "c1", name: "echo", input: { value: "x" } }],
      },
    ]);

    const chunks = await collect(model.stream(userMessage));

    const toolChunk = chunks.find(c => c.type === "tool-call");
    const doneChunk = chunks.find(c => c.type === "done");

    expect(toolChunk).toEqual({
      type: "tool-call",
      id: "c1",
      name: "echo",
      input: { value: "x" },
    });
    // Done is last; tool-call precedes it.
    expect(chunks[chunks.length - 1]).toBe(doneChunk);
  });

  it("carries the synthesized usage on the done chunk", async () => {
    const model = new MockModel("m", [
      { content: "abcd", usage: { input: 1, output: 1, total: 2 } },
    ]);

    const chunks = await collect(model.stream(userMessage));
    const done = chunks.find(c => c.type === "done");

    expect(done).toMatchObject({
      finishReason: "stop",
      usage: { input: 1, output: 1, total: 2 },
    });
  });

  it("records the call and advances the queue like complete()", async () => {
    const model = new MockModel("m", [
      { content: "one" },
      { content: "two" },
    ]);

    await collect(model.stream(userMessage));
    const second = await model.complete(userMessage);

    expect(model.callCount).toBe(2);
    expect(second.content).toBe("two");
  });

  it("throws the scripted error before yielding any chunk", async () => {
    const model = new MockModel("m", [{ content: "", error: new Error("nope") }]);

    await expect(collect(model.stream(userMessage))).rejects.toThrow("nope");
  });
});

describe("MockModel.reset", () => {
  it("clears call history and rewinds the response queue", async () => {
    const model = new MockModel("m", [
      { content: "first" },
      { content: "second" },
    ]);

    await model.complete(userMessage);
    await model.complete(userMessage);
    expect(model.callCount).toBe(2);

    model.reset();

    expect(model.callCount).toBe(0);
    expect(model.callHistory).toEqual([]);

    // Queue pointer is back at the start.
    const afterReset = await model.complete(userMessage);
    expect(afterReset.content).toBe("first");
  });
});
