import type { CacheDriver, CacheSimilarHit } from "@warlock.js/cache";
import type { EmbedderContract } from "../contracts/embedder.contract";
import type {
  MemoryItem,
  RecalledMemory,
} from "../contracts/memory/memory-item.type";
import { deriveMemoryId } from "./derive-id";

/**
 * Shape persisted per episode. `ts` is the wall-clock time the episode
 * was remembered — the basis for the recency half of the blended recall
 * score. The vector lives in the driver's index (via `set({ vector })`),
 * so it is not duplicated here.
 */
type StoredEpisode = {
  id: string;
  text: string;
  ts: number;
  metadata?: Record<string, unknown>;
};

/**
 * How many extra candidates to pull from `similar()` before re-ranking by
 * the recency-blended score and slicing to `k`. Recency can promote a
 * slightly-less-similar-but-recent episode past a stale exact match, so
 * the raw top-`k` by similarity alone would miss it — overscan, then
 * re-rank.
 */
const RECALL_OVERSCAN = 5;

/**
 * Episodic recall tier (memory core M2).
 *
 * Holds a durable, timestamped log of *what happened* — events/episodes —
 * and retrieves the ones most relevant to a query, **blended with
 * recency** so recent episodes outrank stale ones at equal similarity.
 * That recency weighting is the whole difference from the {@link
 * import("./semantic-memory").SemanticMemory} tier (pure similarity over
 * timeless facts): episodic memory is time-anchored.
 *
 * Like the semantic tier it delegates the similarity search to the
 * `@warlock.js/cache` driver's `similar()` and never implements ANN
 * itself; it adds a stored `ts` per entry and a decay curve at recall.
 * The blended `score` stays in `[0, 1]` so a consumer can merge episodic
 * hits with the other tiers and sort on one field.
 *
 * Internal to the `memory()` factory — never exported on the package
 * surface.
 */
export class EpisodicMemory {
  public constructor(
    private readonly embedder: EmbedderContract,
    private readonly store: CacheDriver<any, any>,
    private readonly namespace: string,
    private readonly recencyWeight: number,
    private readonly halfLifeMs: number,
    private readonly now: () => number,
  ) {}

  /**
   * Embed the episode text and index it under a namespaced, id-derived
   * key, stamping the current time. Re-remembering the same id overwrites
   * the prior entry (and refreshes its timestamp).
   */
  public async remember(item: MemoryItem): Promise<void> {
    const id = item.id ?? deriveMemoryId(item.text);
    const { vector } = await this.embedder.embed(item.text);

    const value: StoredEpisode = {
      id,
      text: item.text,
      ts: this.now(),
      metadata: item.metadata,
    };

    await this.store.set(this.keyFor(id), value, { vector });
  }

  /**
   * Embed `query`, pull the nearest episodes clearing the similarity
   * `threshold`, then re-rank each by a recency-blended score before
   * returning the top `k`. The similarity floor still gates relevance —
   * recency only reorders episodes that already cleared it, it never
   * surfaces an irrelevant-but-recent one.
   */
  public async recall(
    query: string,
    k: number,
    threshold: number,
  ): Promise<RecalledMemory[]> {
    const { vector } = await this.embedder.embed(query);

    const hits = await this.store.similar<StoredEpisode>(vector, {
      topK: Math.max(k * RECALL_OVERSCAN, k),
      threshold,
    });

    const prefix = `${this.namespace}.`;
    const now = this.now();

    return hits
      .filter((hit: CacheSimilarHit<StoredEpisode>) =>
        hit.key.startsWith(prefix),
      )
      .map((hit: CacheSimilarHit<StoredEpisode>) => ({
        id: hit.value.id,
        text: hit.value.text,
        tier: "episodic" as const,
        score: this.blend(hit.score, hit.value.ts, now),
        metadata: hit.value.metadata,
      }))
      .sort((first, second) => second.score - first.score)
      .slice(0, k);
  }

  /** Drop every episode written under this instance's namespace. */
  public async clear(): Promise<void> {
    await this.store.removeNamespace(this.namespace);
  }

  /**
   * Combine raw similarity with an exponential recency decay:
   * `(1 - w)·similarity + w·0.5^(age / halfLife)`. A just-remembered
   * episode contributes a recency of `1`; one `halfLife` old, `0.5`;
   * older trends toward `0`. With `recencyWeight` 0 the score is pure
   * similarity (an opt-out back to semantic-style ranking).
   */
  private blend(similarity: number, ts: number, now: number): number {
    const ageMs = Math.max(0, now - ts);
    const recency = 0.5 ** (ageMs / this.halfLifeMs);

    return (1 - this.recencyWeight) * similarity + this.recencyWeight * recency;
  }

  /**
   * Namespaced key for an entry. Mirrors the semantic tier's dot
   * separator so the prefix used here matches the `hit.key` the driver
   * returns from `similar()`.
   */
  private keyFor(id: string): string {
    return `${this.namespace}.${id}`;
  }
}
