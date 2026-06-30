import { MemoryCacheDriver } from "@warlock.js/cache";
import { describe, expect, it } from "vitest";
import { cacheVectorStore } from "./cache-vector-store";

/** A MemoryCacheDriver wired the way the vector tiers expect. */
function makeStore(): MemoryCacheDriver {
  const driver = new MemoryCacheDriver();
  driver.setOptions({});
  driver.setLoggingState(false);

  return driver;
}

describe("cacheVectorStore", () => {
  it("round-trips upsert → query by cosine similarity", async () => {
    const store = cacheVectorStore(makeStore());

    await store.upsert("ns.a", { text: "alpha" }, [1, 0, 0]);
    await store.upsert("ns.b", { text: "beta" }, [0, 1, 0]);

    const hits = await store.query<{ text: string }>([1, 0, 0], { topK: 5 });

    expect(hits[0].key).toBe("ns.a");
    expect(hits[0].value.text).toBe("alpha");
    expect(hits[0].score).toBeGreaterThan(hits[1]?.score ?? 0);
  });

  it("filters hits below the threshold", async () => {
    const store = cacheVectorStore(makeStore());

    await store.upsert("ns.a", { text: "alpha" }, [1, 0, 0]);
    await store.upsert("ns.b", { text: "beta" }, [0, 1, 0]);

    const hits = await store.query<{ text: string }>([1, 0, 0], {
      topK: 5,
      threshold: 0.9,
    });

    expect(hits.every((hit) => hit.score >= 0.9)).toBe(true);
    expect(hits.some((hit) => hit.key === "ns.b")).toBe(false);
  });

  it("restricts to tagged entries when tags are given", async () => {
    const store = cacheVectorStore(makeStore());

    await store.upsert("ns.a", { text: "alpha" }, [1, 0, 0], ["docs"]);
    await store.upsert("ns.b", { text: "beta" }, [1, 0, 0], ["tickets"]);

    const hits = await store.query<{ text: string }>([1, 0, 0], {
      topK: 5,
      tags: ["docs"],
    });

    expect(hits.map((hit) => hit.key)).toEqual(["ns.a"]);
  });

  it("removes every entry under a namespace", async () => {
    const driver = makeStore();
    const store = cacheVectorStore(driver);

    await store.upsert("scope.one", { text: "x" }, [1, 0, 0]);
    await store.upsert("scope.two", { text: "y" }, [1, 0, 0]);

    await store.removeNamespace("scope");

    const hits = await store.query<{ text: string }>([1, 0, 0], { topK: 5 });

    expect(hits).toHaveLength(0);
  });

  it("passes an unsupported-driver error through unchanged", async () => {
    const failing = {
      async set() {
        throw new Error("CacheUnsupportedError: no similarity index");
      },
      async similar() {
        throw new Error("CacheUnsupportedError: no similarity index");
      },
      async removeNamespace() {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const store = cacheVectorStore(failing);

    await expect(store.upsert("k", {}, [1])).rejects.toThrow("CacheUnsupportedError");
    await expect(store.query([1], { topK: 1 })).rejects.toThrow("CacheUnsupportedError");
  });
});
