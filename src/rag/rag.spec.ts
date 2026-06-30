import { MemoryCacheDriver } from "@warlock.js/cache";
import { describe, expect, it } from "vitest";
import type {
  EmbedderContract,
  EmbeddingBatchResult,
  EmbeddingResult,
} from "../contracts/embedder.contract";
import { rag } from "./rag";
import { FakeEmbedder, makeDocs } from "./test-support/make-docs";

function makeStore(): MemoryCacheDriver {
  const driver = new MemoryCacheDriver();
  driver.setOptions({});
  driver.setLoggingState(false);

  return driver;
}

describe("rag — index → retrieve", () => {
  it("indexes documents then retrieves cited chunks end-to-end", async () => {
    const kb = rag({
      name: "docs",
      embedder: new FakeEmbedder(),
      store: makeStore(),
      chunk: { type: "recursive", size: 40, overlap: 0 },
    });

    const { chunks } = await kb.index(
      makeDocs([
        { id: "caching", text: "Caching configuration uses drivers and tags. ".repeat(3) },
        { id: "weather", text: "The mountain weather is mild and sunny today. ".repeat(3) },
      ]),
    );

    expect(chunks).toBeGreaterThan(0);

    const result = await kb.retrieve("caching configuration drivers tags", { topK: 3, threshold: 0 });

    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks[0].citation.sourceId).toBe("caching");
  });

  it("batches embedding into one embedMany call per index batch", async () => {
    const embedder = new FakeEmbedder();
    const kb = rag({ name: "docs", embedder, store: makeStore(), chunk: { size: 1000 } });

    await kb.index(makeDocs([{ id: "a", text: "one document body" }]));

    expect(embedder.embedManyCalls).toBe(1);
    expect(embedder.embedCalls).toBe(0);
  });

  it("returns { chunks: 0 } and writes nothing for an empty document", async () => {
    const embedder = new FakeEmbedder();
    const kb = rag({ name: "docs", embedder, store: makeStore() });

    const result = await kb.index(makeDocs([{ id: "blank", text: "   " }]));

    expect(result.chunks).toBe(0);
    expect(embedder.embedManyCalls).toBe(0);
  });

  it("clear() drops everything under the rag namespace", async () => {
    const kb = rag({ name: "docs", embedder: new FakeEmbedder(), store: makeStore(), chunk: { size: 1000 } });

    await kb.index(makeDocs([{ id: "a", text: "alpha beta gamma" }]));
    await kb.clear();

    const result = await kb.retrieve("alpha beta gamma", { topK: 5, threshold: 0 });

    expect(result.chunks).toHaveLength(0);
  });

  it("throws on a dimension mismatch between index and query embedders", async () => {
    // An embedder that indexes at 8 dims but reports 12 dims at query time,
    // simulating "indexed with model A, queried with model B".
    const shifting: EmbedderContract = {
      name: "shifting",
      provider: "fake",
      dimensions: 0,
      async embed(): Promise<EmbeddingResult> {
        return {
          vector: new Array(12).fill(0).map((_, position) => (position === 0 ? 1 : 0)),
          dimensions: 12,
          usage: { promptTokens: 0, totalTokens: 0 },
        };
      },
      async embedMany(inputs: string[]): Promise<EmbeddingBatchResult> {
        return {
          vectors: inputs.map(() => new Array(8).fill(0).map((_, position) => (position === 0 ? 1 : 0))),
          dimensions: 8,
          usage: { promptTokens: 0, totalTokens: 0 },
        };
      },
    };

    const kb = rag({ name: "docs", embedder: shifting, store: makeStore(), chunk: { size: 1000 } });

    await kb.index(makeDocs([{ id: "a", text: "alpha beta" }]));

    await expect(kb.retrieve("alpha beta", { topK: 3, threshold: 0 })).rejects.toThrow(/dimension/i);
  });

  it("throws at construction when no embedder is given", () => {
    expect(() =>
      rag({ embedder: undefined as unknown as EmbedderContract, store: makeStore() }),
    ).toThrow(/embedder/);
  });

  it("throws at construction when no store resolves", () => {
    expect(() => rag({ embedder: new FakeEmbedder() })).toThrow(/store/);
  });
});
