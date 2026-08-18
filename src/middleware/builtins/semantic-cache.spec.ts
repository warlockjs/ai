import { MemoryCacheDriver } from "@warlock.js/cache";
import { describe, expect, it } from "vitest";
import { agent } from "../../agent/agent";
import type {
  EmbedderContract,
  EmbeddingBatchResult,
  EmbeddingResult,
} from "../../contracts/embedder.contract";
import { MockSDK } from "../../mock/mock-sdk";
import { tool } from "../../tool/tool";
import { semanticCache } from "./semantic-cache";

import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Build a fresh MemoryCacheDriver wired the way semanticCache expects
 * (options object initialized, log noise off so test output stays
 * clean). Returns the driver plus a helper that counts stored leaf
 * entries — `data` is nested by parseKey (`ai.cache.<hash>` becomes
 * `{ai:{cache:{<hash>:...}}}`), so a flat key count would lie.
 */
function makeStore() {
  const driver = new MemoryCacheDriver();
  driver.setOptions({});
  driver.setLoggingState(false);

  const countEntries = (): number => {
    let total = 0;
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== "object" || Array.isArray(node))
        return;
      const obj = node as Record<string, unknown>;
      // CacheData wrappers always carry a `data` key. Intermediate
      // namespace nodes (`ai.cache.<hash>` splits into nested
      // objects) do not. The check distinguishes the two.
      if ("data" in obj) {
        total += 1;
        return;
      }
      for (const child of Object.values(obj)) walk(child);
    };
    walk(driver.data);
    return total;
  };

  return { driver, countEntries };
}

/**
 * Deterministic 4-dimensional embedder. Identical strings map to
 * identical vectors (cosine = 1); unrelated strings diverge.
 */
class DeterministicEmbedder implements EmbedderContract {
  public readonly name = "det-embedder";
  public readonly provider = "mock";
  public dimensions = 4;

  public async embed(input: string): Promise<EmbeddingResult> {
    return {
      vector: this.toVector(input),
      dimensions: 4,
      usage: { promptTokens: 0, totalTokens: 0 },
    };
  }

  public async embedMany(inputs: string[]): Promise<EmbeddingBatchResult> {
    return {
      vectors: inputs.map(text => this.toVector(text)),
      dimensions: 4,
      usage: { promptTokens: 0, totalTokens: 0 },
    };
  }

  private toVector(text: string): number[] {
    const buckets = [0, 0, 0, 0];

    for (let index = 0; index < text.length; index++) {
      buckets[index % 4] += text.charCodeAt(index);
    }

    const norm =
      Math.sqrt(buckets.reduce((sum, value) => sum + value * value, 0)) || 1;

    return buckets.map(value => value / norm);
  }
}

describe("semanticCache — exact-match path", () => {
  it("serves an exact-match hit without embedding or calling the model", async () => {
    const sdk = MockSDK({
      responses: [
        {
          content: "first answer",
          finishReason: "stop",
          usage: { input: 5, output: 5, total: 10 },
        },
        { content: "fallback", finishReason: "stop" },
      ],
    });
    const model = sdk.model({ name: "gpt-test" });
    const mockModel = sdk.models[sdk.models.length - 1];
    const { driver: store, countEntries } = makeStore();

    const ai = agent({
      model,
      middleware: [
        semanticCache({
          embedder: new DeterministicEmbedder(),
          store,
          threshold: 0.99,
        }),
      ],
    });

    const firstRun = await ai.execute("identical question");

    expect(firstRun.text).toBe("first answer");
    expect(firstRun.usage.total).toBeGreaterThan(0);
    expect(countEntries()).toBe(1);

    const secondRun = await ai.execute("identical question");

    expect(secondRun.text).toBe("first answer");
    expect(secondRun.usage.total).toBe(0);
    expect(mockModel.callCount).toBe(1);
  });
});

describe("semanticCache — vector-match path", () => {
  it("serves a cached response for a semantically close prompt", async () => {
    const sdk = MockSDK({
      responses: [
        { content: "42", finishReason: "stop" },
        { content: "different", finishReason: "stop" },
      ],
    });
    const model = sdk.model({ name: "gpt-test" });
    const mockModel = sdk.models[sdk.models.length - 1];
    const { driver: store, countEntries } = makeStore();

    const ai = agent({
      model,
      middleware: [
        semanticCache({
          embedder: new DeterministicEmbedder(),
          store,
          threshold: 0.5,
        }),
      ],
    });

    await ai.execute("What is the meaning of life?");

    const secondRun = await ai.execute("Explain the meaning of life please");

    expect(secondRun.text).toBe("42");
    expect(secondRun.usage.total).toBe(0);
    expect(mockModel.callCount).toBe(1);
  });

  it("falls through to the LLM when no cached entry clears the threshold", async () => {
    const sdk = MockSDK({
      responses: [
        { content: "A", finishReason: "stop" },
        { content: "B", finishReason: "stop" },
      ],
    });
    const model = sdk.model({ name: "gpt-test" });
    const mockModel = sdk.models[sdk.models.length - 1];

    const ai = agent({
      model,
      middleware: [
        semanticCache({
          embedder: new DeterministicEmbedder(),
          store: makeStore().driver,
          threshold: 0.999,
        }),
      ],
    });

    await ai.execute("how do I boil water");
    const secondRun = await ai.execute(
      "unrelated topic about JavaScript frameworks",
    );

    expect(secondRun.text).toBe("B");
    expect(mockModel.callCount).toBe(2);
  });
});

describe("semanticCache — TTL expiry", () => {
  it("treats an entry older than ttlMs as a miss", async () => {
    const sdk = MockSDK({
      responses: [
        { content: "first", finishReason: "stop" },
        { content: "second", finishReason: "stop" },
      ],
    });
    const model = sdk.model({ name: "gpt-test" });
    const mockModel = sdk.models[sdk.models.length - 1];
    const { driver: store, countEntries } = makeStore();

    const now = { value: 1_000_000 };
    const originalNow = Date.now;
    Date.now = () => now.value;

    try {
      const ai = agent({
        model,
        middleware: [
          semanticCache({
            embedder: new DeterministicEmbedder(),
            store,
            threshold: 0.5,
            ttlMs: 1000,
          }),
        ],
      });

      await ai.execute("cache me");
      expect(mockModel.callCount).toBe(1);

      now.value += 2000;

      const secondRun = await ai.execute("cache me");

      expect(secondRun.text).toBe("second");
      expect(mockModel.callCount).toBe(2);
    } finally {
      Date.now = originalNow;
    }
  });
});

describe("semanticCache — hash discrimination", () => {
  it("produces distinct cache entries for distinct prompts", async () => {
    const sdk = MockSDK({
      responses: [
        { content: "A", finishReason: "stop" },
        { content: "B", finishReason: "stop" },
        { content: "C", finishReason: "stop" },
      ],
    });
    const model = sdk.model({ name: "gpt-test" });
    const mockModel = sdk.models[sdk.models.length - 1];

    const ai = agent({
      model,
      middleware: [
        semanticCache({
          embedder: new DeterministicEmbedder(),
          store: makeStore().driver,
          threshold: 0.99999,
        }),
      ],
    });

    expect((await ai.execute("first question")).text).toBe("A");
    expect((await ai.execute("second question")).text).toBe("B");
    expect((await ai.execute("third question")).text).toBe("C");
    expect(mockModel.callCount).toBe(3);

    expect((await ai.execute("first question")).text).toBe("A");
    expect((await ai.execute("second question")).text).toBe("B");
    expect(mockModel.callCount).toBe(3);
  });
});

describe("semanticCache — namespace isolation", () => {
  it("does not return hits written under a different namespace", async () => {
    const sdk = MockSDK({
      responses: [
        { content: "ns-a answer", finishReason: "stop" },
        { content: "ns-b answer", finishReason: "stop" },
      ],
    });
    const model = sdk.model({ name: "gpt-test" });
    const mockModel = sdk.models[sdk.models.length - 1];
    const { driver: store, countEntries } = makeStore();

    const firstAgent = agent({
      model,
      middleware: [
        semanticCache({
          embedder: new DeterministicEmbedder(),
          store,
          threshold: 0.5,
          namespace: "ns-a",
        }),
      ],
    });

    const secondAgent = agent({
      model,
      middleware: [
        semanticCache({
          embedder: new DeterministicEmbedder(),
          store,
          threshold: 0.5,
          namespace: "ns-b",
        }),
      ],
    });

    await firstAgent.execute("same question");
    const crossRun = await secondAgent.execute("same question");

    expect(crossRun.text).toBe("ns-b answer");
    expect(mockModel.callCount).toBe(2);
  });
});

describe("semanticCache — multi-trip / tool-using agents", () => {
  /**
   * Regression: in v3.1 the cache short-circuited every trip in a
   * tool-using loop because `extractUserText` walks back to the most
   * recent `user` message — which is the original prompt on every
   * trip (tool messages have role `"tool"`). The semantic match hit
   * the trip-0 cached response on every subsequent trip, replaying
   * the same `tool_calls` request until `maxTrips` blew up. The cache
   * now only consults the store on `tripIndex === 0`.
   */
  it("does not short-circuit follow-up trips in a tool-using agent", async () => {
    const echoSchema: StandardSchemaV1<{ value: string }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: value =>
          typeof value === "object" &&
          value !== null &&
          typeof (value as { value?: unknown }).value === "string"
            ? { value: value as { value: string } }
            : { issues: [{ message: "expected { value: string }" }] },
      },
    };

    const echoTool = tool({
      name: "echo",
      description: "echoes input",
      input: echoSchema,
      execute: async ({ value }) => `echoed:${value}`,
    });

    const sdk = MockSDK({
      responses: [
        {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "t1", name: "echo", input: { value: "hi" } }],
        },
        { content: "final answer", finishReason: "stop" },
      ],
    });
    const model = sdk.model({ name: "gpt-test" });
    const mockModel = sdk.models[sdk.models.length - 1];

    const ai = agent({
      model,
      tools: [echoTool],
      middleware: [
        semanticCache({
          embedder: new DeterministicEmbedder(),
          store: makeStore().driver,
          threshold: 0.95,
        }),
      ],
      maxTrips: 5,
    });

    const result = await ai.execute("call echo please");

    expect(result.error).toBeUndefined();
    expect(result.text).toBe("final answer");
    // Two real model calls: trip 0 (tool_calls) + trip 1 (final).
    expect(mockModel.callCount).toBe(2);
    // Tool ran exactly once — it didn't loop.
    expect(result.report.children.filter(c => c.type === "tool")).toHaveLength(
      1,
    );
  });

  /**
   * Regression: `tool_calls` responses from trip 0 used to be cached
   * and served back on the next run, short-circuiting before the tool
   * ever executed. Mid-stream responses must never enter the store.
   */
  it("never caches a tool_calls response", async () => {
    const echoSchema: StandardSchemaV1<{ value: string }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: value =>
          typeof value === "object" &&
          value !== null &&
          typeof (value as { value?: unknown }).value === "string"
            ? { value: value as { value: string } }
            : { issues: [{ message: "expected { value: string }" }] },
      },
    };

    const echoTool = tool({
      name: "echo",
      description: "echoes input",
      input: echoSchema,
      execute: async ({ value }) => `echoed:${value}`,
    });

    const sdk = MockSDK({
      responses: [
        // Run 1
        {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "a", name: "echo", input: { value: "x" } }],
        },
        { content: "answer-1", finishReason: "stop" },
        // Run 2 — cache must NOT serve trip-0 from run 1; tool_calls
        // responses are never stored.
        {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "b", name: "echo", input: { value: "x" } }],
        },
        { content: "answer-2", finishReason: "stop" },
      ],
    });
    const model = sdk.model({ name: "gpt-test" });
    const mockModel = sdk.models[sdk.models.length - 1];
    const { driver: store, countEntries } = makeStore();

    const ai = agent({
      model,
      tools: [echoTool],
      middleware: [
        semanticCache({
          embedder: new DeterministicEmbedder(),
          store,
          threshold: 0.99,
        }),
      ],
      maxTrips: 5,
    });

    const firstRun = await ai.execute("identical question");
    expect(firstRun.error).toBeUndefined();

    // After run 1: the post-tool final answer ("answer-1") MUST be in
    // the store under the trip-0 prompt key. The intermediate
    // tool_calls response stays out — the pending entry survived the
    // tool_calls trip so the final-stop trip could write it.
    expect(countEntries()).toBe(1);

    const secondRun = await ai.execute("identical question");
    expect(secondRun.error).toBeUndefined();

    // Run 2 hits the cache on trip 0 — it serves the cached
    // "answer-1" final response directly, skipping both LLM calls
    // and the tool. Cache hit zeros out usage; the original two
    // model calls are from run 1 only.
    expect(secondRun.text).toBe("answer-1");
    expect(secondRun.usage.total).toBe(0);
    expect(mockModel.callCount).toBe(2);
  });
});

/**
 * Per-session scoping (4.15.0 security fix — cross-user cache poisoning
 * and leakage). One `semanticCache` instance is normally built at boot
 * and shared by every end user, and a hit is returned as the model's
 * answer with no LLM call in between — so before this fix user B's
 * near-enough prompt was served user A's cached response verbatim, and
 * an attacker could seed an entry near a predictable future query.
 * Entries are now keyed off the run's `sessionId` and a lookup only
 * sees entries written under the same key.
 */
describe("semanticCache — session scoping (security)", () => {
  it("does not serve one session's cached answer to another session", async () => {
    const sdk = MockSDK({
      responses: [
        { content: "user A private answer", finishReason: "stop" },
        { content: "user B answer", finishReason: "stop" },
      ],
    });
    const model = sdk.model({ name: "gpt-test" });
    const mockModel = sdk.models[sdk.models.length - 1];
    const { driver: store } = makeStore();

    const ai = agent({
      model,
      middleware: [
        semanticCache({
          embedder: new DeterministicEmbedder(),
          store,
          // Low threshold: the vector path WOULD match across sessions
          // if the scope filter were not applied.
          threshold: 0.1,
        }),
      ],
    });

    await ai.execute("what is my account balance", { sessionId: "user-a" });
    const bRun = await ai.execute("what is my account balance", {
      sessionId: "user-b",
    });

    expect(bRun.text).toBe("user B answer");
    expect(bRun.usage.total).toBeGreaterThan(0);
    expect(mockModel.callCount).toBe(2);
  });

  it("still serves a hit back to the same session", async () => {
    const sdk = MockSDK({
      responses: [
        { content: "cached answer", finishReason: "stop" },
        { content: "should not be reached", finishReason: "stop" },
      ],
    });
    const model = sdk.model({ name: "gpt-test" });
    const mockModel = sdk.models[sdk.models.length - 1];
    const { driver: store } = makeStore();

    const ai = agent({
      model,
      middleware: [
        semanticCache({
          embedder: new DeterministicEmbedder(),
          store,
          threshold: 0.5,
        }),
      ],
    });

    await ai.execute("what is the meaning of life?", { sessionId: "user-a" });

    // Exact-match path.
    const exact = await ai.execute("what is the meaning of life?", {
      sessionId: "user-a",
    });
    // Vector path — different text, same session.
    const near = await ai.execute("Explain the meaning of life please", {
      sessionId: "user-a",
    });

    expect(exact.text).toBe("cached answer");
    expect(near.text).toBe("cached answer");
    expect(near.usage.total).toBe(0);
    expect(mockModel.callCount).toBe(1);
  });

  it("a foreign session's near-identical entries cannot starve a scoped hit", async () => {
    const sdk = MockSDK({
      responses: [
        { content: "noise 0", finishReason: "stop" },
        { content: "noise 1", finishReason: "stop" },
        { content: "noise 2", finishReason: "stop" },
        { content: "mine", finishReason: "stop" },
        { content: "should not be reached", finishReason: "stop" },
      ],
    });
    const model = sdk.model({ name: "gpt-test" });
    const mockModel = sdk.models[sdk.models.length - 1];
    const { driver: store } = makeStore();

    const ai = agent({
      model,
      middleware: [
        semanticCache({
          embedder: new DeterministicEmbedder(),
          store,
          threshold: 0.1,
        }),
      ],
    });

    // One session each, so the seeded entries don't hit one another —
    // three foreign entries land in the driver's index ranked near the
    // victim's future query.
    for (let index = 0; index < 3; index++) {
      await ai.execute(`shared topic question ${index}`, {
        sessionId: `attacker-${index}`,
      });
    }

    await ai.execute("shared topic question mine", { sessionId: "victim" });
    expect(mockModel.callCount).toBe(4);

    // The driver ranks across every scope, so a naive top-1 would come
    // back as an attacker entry and mask the victim's own. The overscan
    // + scope filter keeps the legitimate hit reachable.
    const repeat = await ai.execute("shared topic question mine", {
      sessionId: "victim",
    });

    expect(repeat.text).toBe("mine");
    expect(repeat.usage.total).toBe(0);
    expect(mockModel.callCount).toBe(4);
  });

  it("scope: \"shared\" opts back into one pool across sessions", async () => {
    const sdk = MockSDK({
      responses: [
        { content: "public FAQ answer", finishReason: "stop" },
        { content: "should not be reached", finishReason: "stop" },
      ],
    });
    const model = sdk.model({ name: "gpt-test" });
    const mockModel = sdk.models[sdk.models.length - 1];
    const { driver: store } = makeStore();

    const ai = agent({
      model,
      middleware: [
        semanticCache({
          embedder: new DeterministicEmbedder(),
          store,
          threshold: 0.5,
          scope: "shared",
        }),
      ],
    });

    await ai.execute("what are your opening hours", { sessionId: "user-a" });
    const bRun = await ai.execute("what are your opening hours", {
      sessionId: "user-b",
    });

    expect(bRun.text).toBe("public FAQ answer");
    expect(bRun.usage.total).toBe(0);
    expect(mockModel.callCount).toBe(1);
  });

  it("a scope resolver isolates by tenant instead of by session", async () => {
    const sdk = MockSDK({
      responses: [
        { content: "tenant one answer", finishReason: "stop" },
        { content: "tenant two answer", finishReason: "stop" },
      ],
    });
    const model = sdk.model({ name: "gpt-test" });
    const mockModel = sdk.models[sdk.models.length - 1];
    const { driver: store } = makeStore();

    const tenantOf = (sessionId: string | undefined): string =>
      sessionId?.startsWith("t1-") ? "tenant-1" : "tenant-2";

    const ai = agent({
      model,
      middleware: [
        semanticCache({
          embedder: new DeterministicEmbedder(),
          store,
          threshold: 0.5,
          scope: (context) => tenantOf(context.options?.sessionId),
        }),
      ],
    });

    await ai.execute("shared question", { sessionId: "t1-alice" });

    // Same tenant, different session → hit.
    const sibling = await ai.execute("shared question", { sessionId: "t1-bob" });
    // Different tenant → miss.
    const foreign = await ai.execute("shared question", { sessionId: "t2-eve" });

    expect(sibling.text).toBe("tenant one answer");
    expect(sibling.usage.total).toBe(0);
    expect(foreign.text).toBe("tenant two answer");
    expect(mockModel.callCount).toBe(2);
  });

  it("an unscoped run reads only the unscoped pool — a session entry is not visible to it", async () => {
    const sdk = MockSDK({
      responses: [
        { content: "session answer", finishReason: "stop" },
        { content: "anonymous answer", finishReason: "stop" },
      ],
    });
    const model = sdk.model({ name: "gpt-test" });
    const mockModel = sdk.models[sdk.models.length - 1];
    const { driver: store } = makeStore();

    const ai = agent({
      model,
      middleware: [
        semanticCache({
          embedder: new DeterministicEmbedder(),
          store,
          threshold: 0.1,
        }),
      ],
    });

    await ai.execute("same question", { sessionId: "user-a" });
    const anonymous = await ai.execute("same question");

    expect(anonymous.text).toBe("anonymous answer");
    expect(mockModel.callCount).toBe(2);
  });
});
