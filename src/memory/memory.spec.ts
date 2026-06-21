import { MemoryCacheDriver } from "@warlock.js/cache";
import { describe, expect, it } from "vitest";
import type {
  EmbedderContract,
  EmbeddingBatchResult,
  EmbeddingResult,
} from "../contracts/embedder.contract";
import { memory } from "./memory";

/**
 * Build a MemoryCacheDriver wired the way the semantic tier expects
 * (options initialized, log noise off). Mirrors the semantic-cache spec
 * helper so behavior matches the shipped middleware.
 */
function makeStore(): MemoryCacheDriver {
  const driver = new MemoryCacheDriver();
  driver.setOptions({});
  driver.setLoggingState(false);

  return driver;
}

/**
 * Deterministic 4-dimensional embedder. Identical strings map to
 * identical vectors (cosine = 1); unrelated strings diverge. Copied
 * from the semantic-cache spec so memory recall is exercised against
 * the same MockSDK-style embedder the package already tests with.
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
      vectors: inputs.map((text) => this.toVector(text)),
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

    return buckets.map((value) => value / norm);
  }
}

describe("memory — construction", () => {
  it("defaults to a working-only memory", async () => {
    const mem = memory();

    await mem.remember({ text: "first" });
    const hits = await mem.recall("anything");

    expect(hits).toHaveLength(1);
    expect(hits[0].tier).toBe("working");
    expect(hits[0].text).toBe("first");
  });

  it("throws when no tier is enabled", () => {
    expect(() => memory({ working: false })).toThrow(/no tier enabled/);
  });

  it("throws when the semantic tier has no store and no default", () => {
    expect(() =>
      memory({ working: false, semantic: { embedder: new DeterministicEmbedder() } }),
    ).toThrow(/no store/);
  });

  it("throws when defaultTier references a disabled tier", () => {
    expect(() => memory({ defaultTier: "semantic" })).toThrow(
      /semantic tier is not configured/,
    );
  });
});

describe("memory — working tier", () => {
  it("recalls most-recent items first", async () => {
    const mem = memory();

    await mem.remember([{ text: "oldest" }, { text: "middle" }, { text: "newest" }]);
    const hits = await mem.recall("query", { k: 2 });

    expect(hits.map((hit) => hit.text)).toEqual(["newest", "middle"]);
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score);
  });

  it("overwrites an entry sharing an explicit id", async () => {
    const mem = memory();

    await mem.remember({ id: "u1", text: "version one" });
    await mem.remember({ id: "u1", text: "version two" });

    const hits = await mem.recall("query");

    expect(hits).toHaveLength(1);
    expect(hits[0].text).toBe("version two");
  });

  it("clears the working tier", async () => {
    const mem = memory();

    await mem.remember({ text: "ephemeral" });
    await mem.clear("working");

    expect(await mem.recall("query")).toHaveLength(0);
  });

  it("round-trips metadata", async () => {
    const mem = memory();

    await mem.remember({ text: "tagged", metadata: { source: "chat" } });
    const [hit] = await mem.recall("query");

    expect(hit.metadata).toEqual({ source: "chat" });
  });
});

describe("memory — semantic tier", () => {
  it("recalls a semantically close memory above threshold", async () => {
    const mem = memory({
      working: false,
      defaultTier: "semantic",
      semantic: { embedder: new DeterministicEmbedder(), store: makeStore() },
      threshold: 0.5,
    });

    await mem.remember({ text: "The user lives in Cairo" });
    const hits = await mem.recall("Where does the user live?", { k: 1 });

    expect(hits).toHaveLength(1);
    expect(hits[0].tier).toBe("semantic");
    expect(hits[0].score).toBeGreaterThanOrEqual(0.5);
  });

  it("returns nothing when no memory clears the threshold", async () => {
    const mem = memory({
      working: false,
      defaultTier: "semantic",
      semantic: { embedder: new DeterministicEmbedder(), store: makeStore() },
      threshold: 0.99999,
    });

    await mem.remember({ text: "boiling water requires heat" });
    const hits = await mem.recall("unrelated JavaScript frameworks");

    expect(hits).toHaveLength(0);
  });

  it("does not leak memories across namespaces on a shared store", async () => {
    const store = makeStore();
    const embedder = new DeterministicEmbedder();

    const first = memory({
      working: false,
      defaultTier: "semantic",
      semantic: { embedder, store, namespace: "ns-a" },
      threshold: 0.1,
    });
    const second = memory({
      working: false,
      defaultTier: "semantic",
      semantic: { embedder, store, namespace: "ns-b" },
      threshold: 0.1,
    });

    await first.remember({ text: "secret from A" });
    const crossHits = await second.recall("secret from A");

    expect(crossHits).toHaveLength(0);
  });

  it("falls back to ai.config defaultStore when no store is supplied", async () => {
    const { setAIConfig } = await import("../config");
    const store = makeStore();
    setAIConfig({ defaultStore: store });

    try {
      const mem = memory({
        working: false,
        defaultTier: "semantic",
        semantic: { embedder: new DeterministicEmbedder(), namespace: "ns-default" },
        threshold: 0.5,
      });

      await mem.remember({ text: "config-resolved store works" });
      const hits = await mem.recall("config-resolved store works", { k: 1 });

      expect(hits).toHaveLength(1);
    } finally {
      setAIConfig({ defaultStore: undefined });
    }
  });

  it("clears only the semantic tier when asked", async () => {
    const mem = memory({
      semantic: { embedder: new DeterministicEmbedder(), store: makeStore() },
      threshold: 0.1,
    });

    await mem.remember({ text: "working note" });
    await mem.remember({ text: "semantic note", tier: "semantic" });
    await mem.clear("semantic");

    const hits = await mem.recall("note");

    expect(hits.every((hit) => hit.tier === "working")).toBe(true);
    expect(hits.map((hit) => hit.text)).toContain("working note");
  });
});

describe("memory — mixed recall", () => {
  it("merges working and semantic hits ordered by score and capped at k", async () => {
    const mem = memory({
      semantic: { embedder: new DeterministicEmbedder(), store: makeStore() },
      threshold: 0.1,
      k: 3,
    });

    await mem.remember([
      { text: "recent working memory" },
      { text: "the meaning of life", tier: "semantic" },
    ]);

    const hits = await mem.recall("the meaning of life", { k: 3 });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(3);

    for (let index = 1; index < hits.length; index++) {
      expect(hits[index - 1].score).toBeGreaterThanOrEqual(hits[index].score);
    }
  });

  it("restricts recall to a single tier when options.tier is set", async () => {
    const mem = memory({
      semantic: { embedder: new DeterministicEmbedder(), store: makeStore() },
      threshold: 0.1,
    });

    await mem.remember({ text: "working only" });
    await mem.remember({ text: "semantic only", tier: "semantic" });

    const workingHits = await mem.recall("only", { tier: "working" });
    const semanticHits = await mem.recall("semantic only", { tier: "semantic" });

    expect(workingHits.every((hit) => hit.tier === "working")).toBe(true);
    expect(semanticHits.every((hit) => hit.tier === "semantic")).toBe(true);
  });
});

describe("memory — episodic tier", () => {
  it("blends recency so a recent episode outranks an older one at equal similarity", async () => {
    let clock = 1_000;
    const mem = memory({
      working: false,
      defaultTier: "episodic",
      episodic: {
        embedder: new DeterministicEmbedder(),
        store: makeStore(),
        now: () => clock,
        recencyWeight: 0.5,
      },
      threshold: 0.1,
    });

    await mem.remember({ id: "old", text: "deployed the billing service" });
    clock = 1_000 + 30 * 24 * 60 * 60 * 1000; // 30 days later
    await mem.remember({ id: "new", text: "deployed the billing service" });

    const hits = await mem.recall("deployed the billing service", {
      tier: "episodic",
      k: 2,
    });

    expect(hits.map((hit) => hit.id)).toEqual(["new", "old"]);
    expect(hits[0].tier).toBe("episodic");
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it("recencyWeight 0 is pure similarity — no recency reordering", async () => {
    let clock = 0;
    const mem = memory({
      working: false,
      defaultTier: "episodic",
      episodic: {
        embedder: new DeterministicEmbedder(),
        store: makeStore(),
        now: () => clock,
        recencyWeight: 0,
      },
      threshold: 0.1,
    });

    await mem.remember({ id: "a", text: "alpha note" });
    clock = 10_000_000_000;
    await mem.remember({ id: "b", text: "alpha note" });

    const hits = await mem.recall("alpha note", { tier: "episodic", k: 2 });

    expect(hits).toHaveLength(2);
    expect(hits[0].score).toBeCloseTo(hits[1].score, 5);
  });

  it("clears only the episodic tier, leaving semantic intact", async () => {
    const mem = memory({
      semantic: {
        embedder: new DeterministicEmbedder(),
        store: makeStore(),
        namespace: "sem",
      },
      episodic: {
        embedder: new DeterministicEmbedder(),
        store: makeStore(),
        namespace: "epi",
      },
      threshold: 0.1,
    });

    await mem.remember({ text: "shared text", tier: "semantic" });
    await mem.remember({ text: "shared text", tier: "episodic" });
    await mem.clear("episodic");

    const hits = await mem.recall("shared text");

    expect(hits.some((hit) => hit.tier === "semantic")).toBe(true);
    expect(hits.some((hit) => hit.tier === "episodic")).toBe(false);
  });
});

describe("memory — procedural tier", () => {
  it("reinforces a procedure on re-remember, raising its recall score", async () => {
    const procedure = "escalate refunds over $500 to a human";
    const mem = memory({
      working: false,
      defaultTier: "procedural",
      procedural: {
        embedder: new DeterministicEmbedder(),
        store: makeStore(),
        reinforcementWeight: 0.5,
      },
      threshold: 0.1,
    });

    await mem.remember({ id: "p", text: procedure });
    const [before] = await mem.recall(procedure, { tier: "procedural", k: 1 });

    await mem.remember({ id: "p", text: procedure }); // reinforce → uses 1 → 2
    const [after] = await mem.recall(procedure, { tier: "procedural", k: 1 });

    expect(before.tier).toBe("procedural");
    expect(after.score).toBeGreaterThan(before.score);
  });

  it("throws when defaultTier references a disabled procedural tier", () => {
    expect(() => memory({ defaultTier: "procedural" })).toThrow(
      /procedural tier is not configured/,
    );
  });

  it("clears only the procedural tier", async () => {
    const mem = memory({
      working: false,
      defaultTier: "procedural",
      procedural: { embedder: new DeterministicEmbedder(), store: makeStore() },
      threshold: 0.1,
    });

    await mem.remember({ text: "a learned procedure" });
    await mem.clear("procedural");

    expect(
      await mem.recall("a learned procedure", { tier: "procedural" }),
    ).toHaveLength(0);
  });
});
