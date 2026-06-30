import type { CacheDriver } from "@warlock.js/cache";
import type { VectorStore } from "./vector-store.contract";

/**
 * Adapt any `@warlock.js/cache` `CacheDriver` to the {@link VectorStore}
 * narrowing the RAG pipeline depends on. The cache driver IS the vector
 * store — exactly as `SemanticMemory` and `semanticCache` already use it:
 *
 * - `upsert` → `driver.set(key, value, { vector, tags })`
 * - `query`  → `driver.similar<T>(vector, { topK, threshold, tags })`
 * - `removeNamespace` → `driver.removeNamespace(namespace)`
 *
 * Drivers without similarity support throw `CacheUnsupportedError` from
 * `set({ vector })` / `similar()`; the error surfaces unchanged so the
 * caller sees the cache layer's own message (pointing at the `pg` /
 * `redis` drivers for production-scale similarity).
 *
 * @example
 * const store = cacheVectorStore(new MemoryCacheDriver());
 * await store.upsert("ai.rag.docs.guide.0", { text: "…" }, vector);
 * const hits = await store.query(queryVector, { topK: 5, threshold: 0.5 });
 */
export function cacheVectorStore(driver: CacheDriver<any, any>): VectorStore {
  return {
    async upsert(
      key: string,
      value: unknown,
      vector: number[],
      tags?: string[],
    ): Promise<void> {
      await driver.set(key, value, tags && tags.length > 0 ? { vector, tags } : { vector });
    },

    async query<T>(
      vector: number[],
      options: { topK: number; threshold?: number; tags?: string[] },
    ): Promise<{ key: string; value: T; score: number }[]> {
      const hits = await driver.similar<T>(vector, {
        topK: options.topK,
        threshold: options.threshold,
        tags: options.tags,
      });

      return hits.map((hit: { key: string; value: T; score: number }) => ({
        key: hit.key,
        value: hit.value,
        score: hit.score,
      }));
    },

    async removeNamespace(namespace: string): Promise<void> {
      await driver.removeNamespace(namespace);
    },
  };
}
