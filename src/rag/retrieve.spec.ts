import { MemoryCacheDriver } from "@warlock.js/cache";
import { describe, expect, it } from "vitest";
import type { RetrievedChunk } from "./contracts/citation.type";
import type { RagReranker } from "./rerank/reranker.contract";
import { cacheVectorStore } from "./store/cache-vector-store";
import type { VectorStore } from "./store/vector-store.contract";
import { retrieve, type StoredChunk } from "./retrieve";
import { FakeEmbedder } from "./test-support/make-docs";

function makeStore(): VectorStore {
  const driver = new MemoryCacheDriver();
  driver.setOptions({});
  driver.setLoggingState(false);

  return cacheVectorStore(driver);
}

/** Upsert a stored chunk under `<namespace>.<sourceId>.<index>` with the embedder's vector. */
async function seed(
  store: VectorStore,
  embedder: FakeEmbedder,
  namespace: string,
  stored: StoredChunk,
  tags?: string[],
): Promise<void> {
  const { vector } = await embedder.embed(stored.text);

  await store.upsert(`${namespace}.${stored.sourceId}.${stored.chunkIndex}`, stored, vector, tags);
}

function storedChunk(over: Partial<StoredChunk> & { sourceId: string; text: string }): StoredChunk {
  return {
    chunkIndex: 0,
    span: [0, over.text.length],
    metadata: undefined,
    ...over,
  };
}

describe("retrieve", () => {
  it("slices to topK after over-fetching candidates", async () => {
    const store = makeStore();
    const embedder = new FakeEmbedder();
    const namespace = "ai.rag.docs";

    for (let index = 0; index < 8; index += 1) {
      await seed(
        store,
        embedder,
        namespace,
        storedChunk({ sourceId: "doc", chunkIndex: index, text: `aaaa bbbb chunk ${index}` }),
      );
    }

    const result = await retrieve("aaaa bbbb", { embedder, store, namespace }, { topK: 3, threshold: 0 });

    expect(result.chunks).toHaveLength(3);
    expect(result.query).toBe("aaaa bbbb");
  });

  it("builds a citation with sourceId, chunkIndex, span, score, metadata", async () => {
    const store = makeStore();
    const embedder = new FakeEmbedder();
    const namespace = "ai.rag.docs";

    await seed(
      store,
      embedder,
      namespace,
      storedChunk({
        sourceId: "guide",
        chunkIndex: 2,
        span: [10, 30],
        text: "caching configuration",
        metadata: { url: "/guide" },
      }),
    );

    const result = await retrieve("caching configuration", { embedder, store, namespace }, { topK: 1, threshold: 0 });

    const citation = result.chunks[0].citation;
    expect(citation.sourceId).toBe("guide");
    expect(citation.chunkIndex).toBe(2);
    expect(citation.span).toEqual([10, 30]);
    expect(citation.metadata).toEqual({ url: "/guide" });
    expect(citation.score).toBeCloseTo(result.chunks[0].score, 10);
  });

  it("isolates two rags sharing one driver by namespace prefix", async () => {
    const driver = new MemoryCacheDriver();
    driver.setOptions({});
    driver.setLoggingState(false);
    const store = cacheVectorStore(driver);
    const embedder = new FakeEmbedder();

    await seed(store, embedder, "ai.rag.alpha", storedChunk({ sourceId: "a", text: "shared words here" }));
    await seed(store, embedder, "ai.rag.beta", storedChunk({ sourceId: "b", text: "shared words here" }));

    const result = await retrieve("shared words here", { embedder, store, namespace: "ai.rag.alpha" }, { topK: 5, threshold: 0 });

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].citation.sourceId).toBe("a");
  });

  it("respects the threshold", async () => {
    const store = makeStore();
    const embedder = new FakeEmbedder();
    const namespace = "ai.rag.docs";

    await seed(store, embedder, namespace, storedChunk({ sourceId: "match", text: "alpha alpha alpha" }));
    await seed(store, embedder, namespace, storedChunk({ sourceId: "other", text: "zzzz wwww qqqq" }));

    const result = await retrieve("alpha alpha alpha", { embedder, store, namespace }, { topK: 5, threshold: 0.99 });

    expect(result.chunks.every((chunk) => chunk.score >= 0.99)).toBe(true);
    expect(result.chunks.some((chunk) => chunk.citation.sourceId === "other")).toBe(false);
  });

  it("returns an empty result when nothing clears the threshold", async () => {
    const store = makeStore();
    const embedder = new FakeEmbedder();

    const result = await retrieve("nothing indexed", { embedder, store, namespace: "ai.rag.empty" }, { topK: 5 });

    expect(result).toEqual({ query: "nothing indexed", chunks: [] });
  });

  it("invokes the reranker and honors its order", async () => {
    const store = makeStore();
    const embedder = new FakeEmbedder();
    const namespace = "ai.rag.docs";

    await seed(store, embedder, namespace, storedChunk({ sourceId: "first", text: "aaaa bbbb" }));
    await seed(store, embedder, namespace, storedChunk({ sourceId: "second", text: "aaaa cccc" }));

    let called = false;
    const reverser: RagReranker = {
      name: "reverse",
      async rerank(_query: string, candidates: RetrievedChunk[]): Promise<RetrievedChunk[]> {
        called = true;

        return [...candidates].reverse();
      },
    };

    const result = await retrieve(
      "aaaa bbbb",
      { embedder, store, namespace, reranker: reverser },
      { topK: 5, threshold: 0 },
    );

    expect(called).toBe(true);
    expect(result.chunks).toHaveLength(2);
  });

  it("falls back to cosine order when the reranker throws", async () => {
    const store = makeStore();
    const embedder = new FakeEmbedder();
    const namespace = "ai.rag.docs";

    await seed(store, embedder, namespace, storedChunk({ sourceId: "first", text: "aaaa bbbb" }));
    await seed(store, embedder, namespace, storedChunk({ sourceId: "second", text: "aaaa cccc" }));

    const flaky: RagReranker = {
      name: "flaky",
      async rerank(): Promise<RetrievedChunk[]> {
        throw new Error("reranker down");
      },
    };

    const result = await retrieve(
      "aaaa bbbb",
      { embedder, store, namespace, reranker: flaky },
      { topK: 5, threshold: 0 },
    );

    expect(result.chunks.length).toBeGreaterThan(0);
  });

  it("uses an explicit candidate pool size when given", async () => {
    const store = makeStore();
    const embedder = new FakeEmbedder();
    const namespace = "ai.rag.docs";

    let queriedTopK = 0;
    const spyStore: VectorStore = {
      async upsert() {},
      async query(vector, options) {
        queriedTopK = options.topK;

        return store.query(vector, options);
      },
      async removeNamespace() {},
    };

    await seed(store, embedder, namespace, storedChunk({ sourceId: "a", text: "aaaa bbbb" }));

    await retrieve("aaaa bbbb", { embedder, store: spyStore, namespace }, { topK: 2, candidates: 17, threshold: 0 });

    expect(queriedTopK).toBe(17);
  });
});
