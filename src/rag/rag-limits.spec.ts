import { MemoryCacheDriver } from "@warlock.js/cache";
import { describe, expect, it } from "vitest";
import { rag } from "./rag";
import { FakeEmbedder, makeDocs } from "./test-support/make-docs";

function makeStore(): MemoryCacheDriver {
  const driver = new MemoryCacheDriver();
  driver.setOptions({});
  driver.setLoggingState(false);
  return driver;
}

describe("rag — ingestion limits (D5)", () => {
  it("rejects more documents than maxDocuments before embedding", async () => {
    const kb = rag({
      name: "docs",
      embedder: new FakeEmbedder(),
      store: makeStore(),
      limits: { maxDocuments: 1 },
    });

    await expect(
      kb.index(makeDocs([{ id: "a", text: "one" }, { id: "b", text: "two" }])),
    ).rejects.toThrow(/maxDocuments/);
  });

  it("rejects document text over maxBytes", async () => {
    const kb = rag({
      name: "docs",
      embedder: new FakeEmbedder(),
      store: makeStore(),
      limits: { maxBytes: 10 },
    });

    await expect(
      kb.index(makeDocs([{ id: "a", text: "this is definitely more than ten bytes" }])),
    ).rejects.toThrow(/maxBytes/);
  });

  it("rejects more chunks than maxChunks", async () => {
    const kb = rag({
      name: "docs",
      embedder: new FakeEmbedder(),
      store: makeStore(),
      chunk: { type: "recursive", size: 10, overlap: 0 },
      limits: { maxChunks: 2 },
    });

    await expect(
      kb.index(makeDocs([{ id: "a", text: "alpha beta gamma delta epsilon zeta eta theta" }])),
    ).rejects.toThrow(/maxChunks/);
  });

  it("indexes normally when within all limits", async () => {
    const kb = rag({
      name: "docs",
      embedder: new FakeEmbedder(),
      store: makeStore(),
      chunk: { type: "recursive", size: 1000, overlap: 0 },
      limits: { maxDocuments: 10, maxChunks: 100, maxBytes: 100_000 },
    });

    const { chunks } = await kb.index(makeDocs([{ id: "a", text: "small doc" }]));
    expect(chunks).toBeGreaterThan(0);
  });
});
