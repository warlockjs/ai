/**
 * The three vector operations the RAG pipeline needs, expressed as a thin
 * structural narrowing of the `@warlock.js/cache` `CacheDriver` surface
 * (`set({ vector })` + `similar()` + `removeNamespace()`).
 *
 * This is NOT a new storage engine — v1 has exactly one implementation,
 * {@link cacheVectorStore}, which adapts any `CacheDriver`. The contract
 * exists so a future non-cache backend can be swapped in without touching
 * the pipeline. Cache stays embedding-agnostic; the RAG vocabulary
 * (`upsert` / `query`) lives here, in the rag feature.
 */
export interface VectorStore {
  /**
   * Index a value under `key` with its embedding vector. Optional `tags`
   * are stored alongside the entry so `query({ tags })` can restrict the
   * candidate set to a subset of sources.
   */
  upsert(key: string, value: unknown, vector: number[], tags?: string[]): Promise<void>;
  /**
   * Cosine-nearest entries to `vector` clearing `threshold`, capped at
   * `topK`, optionally restricted to entries carrying one of `tags`.
   */
  query<T>(
    vector: number[],
    options: { topK: number; threshold?: number; tags?: string[] },
  ): Promise<{ key: string; value: T; score: number }[]>;
  /** Drop every entry written under `namespace`. */
  removeNamespace(namespace: string): Promise<void>;
}
