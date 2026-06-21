import type { CacheDriver, CacheSimilarHit } from "@warlock.js/cache";
import type { EmbedderContract } from "../contracts/embedder.contract";
import type {
  MemoryItem,
  RecalledMemory,
} from "../contracts/memory/memory-item.type";
import { deriveMemoryId } from "./derive-id";

/**
 * Shape persisted per semantic memory in the cache driver. The vector
 * itself is stored by the driver's own index (passed via
 * `set({ vector })`), so it is not duplicated in the value.
 */
type StoredMemory = {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
};

/**
 * Semantic recall tier (memory core M1).
 *
 * Owns: embedding remembered text, writing it to a `@warlock.js/cache`
 * driver with `set({ vector })`, and retrieving by cosine similarity via
 * the driver's `similar()`. Does NOT own: the similarity algorithm or
 * the ANN index — those belong to the cache driver. This mirrors the
 * delegation model of `middleware/builtins/semantic-cache.ts`: memory is
 * embedding-agnostic and store-agnostic, gluing an {@link EmbedderContract}
 * to a {@link CacheDriver}.
 *
 * The driver may be shared across memory instances, so every key carries
 * the configured `namespace` and recall filters hits to that prefix —
 * foreign entries indexed by another instance never leak into a query.
 *
 * Internal to the `memory()` factory — never exported on the package
 * surface.
 */
export class SemanticMemory {
  public constructor(
    private readonly embedder: EmbedderContract,
    private readonly store: CacheDriver<any, any>,
    private readonly namespace: string,
  ) {}

  /**
   * Embed the item's text and index it under a namespaced, id-derived
   * key. Re-remembering the same id overwrites the prior vector +
   * value (the driver upserts by key).
   */
  public async remember(item: MemoryItem): Promise<void> {
    const id = item.id ?? deriveMemoryId(item.text);
    const { vector } = await this.embedder.embed(item.text);

    const value: StoredMemory = {
      id,
      text: item.text,
      metadata: item.metadata,
    };

    await this.store.set(this.keyFor(id), value, { vector });
  }

  /**
   * Embed `query`, ask the driver for the `k` nearest entries clearing
   * `threshold`, and return those within this instance's namespace as
   * scored {@link RecalledMemory}. Hits indexed under a different
   * namespace (a shared driver) are filtered out.
   */
  public async recall(
    query: string,
    k: number,
    threshold: number,
  ): Promise<RecalledMemory[]> {
    const { vector } = await this.embedder.embed(query);

    const hits = await this.store.similar<StoredMemory>(vector, {
      topK: k,
      threshold,
    });

    const prefix = `${this.namespace}.`;

    return hits
      .filter((hit: CacheSimilarHit<StoredMemory>) =>
        hit.key.startsWith(prefix),
      )
      .map((hit: CacheSimilarHit<StoredMemory>) => ({
        id: hit.value.id,
        text: hit.value.text,
        tier: "semantic" as const,
        score: hit.score,
        metadata: hit.value.metadata,
      }));
  }

  /** Drop every semantic entry written under this instance's namespace. */
  public async clear(): Promise<void> {
    await this.store.removeNamespace(this.namespace);
  }

  /**
   * Namespaced key for an entry. The cache's `parseKey` normalizes `:`
   * to `.`, so a dot separator keeps the prefix used here aligned with
   * the `hit.key` the driver returns from `similar()`.
   */
  private keyFor(id: string): string {
    return `${this.namespace}.${id}`;
  }
}
