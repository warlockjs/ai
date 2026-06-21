import type { CacheDriver, CacheSimilarHit } from "@warlock.js/cache";
import type { EmbedderContract } from "../contracts/embedder.contract";
import type {
  MemoryItem,
  RecalledMemory,
} from "../contracts/memory/memory-item.type";
import { deriveMemoryId } from "./derive-id";

/**
 * Shape persisted per procedure. `uses` is the reinforcement counter —
 * how many times the procedure has been remembered/re-affirmed — and
 * feeds the reinforcement half of the blended recall score. The vector
 * lives in the driver's index, so it is not duplicated here.
 */
type StoredProcedure = {
  id: string;
  text: string;
  uses: number;
  metadata?: Record<string, unknown>;
};

/**
 * Extra candidates pulled from `similar()` before re-ranking by the
 * reinforcement-blended score and slicing to `k` — reinforcement can
 * promote a well-worn procedure past a slightly-closer one-off, which the
 * raw top-`k` by similarity would miss.
 */
const RECALL_OVERSCAN = 5;

/**
 * Procedural recall tier (memory core M2).
 *
 * Holds durable *how-to* knowledge — learned procedures, policies, and
 * playbooks — and retrieves the ones relevant to a query, **blended with
 * reinforcement** so procedures that have proven themselves (remembered /
 * re-affirmed more often) outrank one-offs at equal similarity. That
 * reinforcement weighting is the difference from the semantic tier (which
 * treats every fact equally): procedural memory gets *stronger with use*.
 *
 * Reinforcement is explicit and side-effect-free on read: re-remembering
 * a procedure (same id, or same text → same derived id) increments its
 * `uses`, so a caller strengthens a procedure by remembering it again
 * after a successful application. Recall never mutates.
 *
 * Like the other vector tiers it delegates similarity to the
 * `@warlock.js/cache` driver's `similar()`. The blended `score` stays in
 * `[0, 1]` so procedural hits merge and sort alongside the other tiers.
 *
 * Internal to the `memory()` factory — never exported on the package
 * surface.
 */
export class ProceduralMemory {
  public constructor(
    private readonly embedder: EmbedderContract,
    private readonly store: CacheDriver<any, any>,
    private readonly namespace: string,
    private readonly reinforcementWeight: number,
  ) {}

  /**
   * Embed the procedure text and index it, incrementing its `uses` when
   * it already exists (reinforcement) or seeding it at `1` when new.
   * Metadata on a reinforcing write wins; an omitted metadata keeps the
   * prior value rather than wiping it.
   */
  public async remember(item: MemoryItem): Promise<void> {
    const id = item.id ?? deriveMemoryId(item.text);
    const { vector } = await this.embedder.embed(item.text);

    const existing = await this.store.get<StoredProcedure>(this.keyFor(id));
    const uses = (existing?.uses ?? 0) + 1;

    const value: StoredProcedure = {
      id,
      text: item.text,
      uses,
      metadata: item.metadata ?? existing?.metadata,
    };

    await this.store.set(this.keyFor(id), value, { vector });
  }

  /**
   * Embed `query`, pull the nearest procedures clearing the similarity
   * `threshold`, then re-rank each by a reinforcement-blended score and
   * return the top `k`. The similarity floor still gates relevance;
   * reinforcement only reorders procedures that already cleared it.
   */
  public async recall(
    query: string,
    k: number,
    threshold: number,
  ): Promise<RecalledMemory[]> {
    const { vector } = await this.embedder.embed(query);

    const hits = await this.store.similar<StoredProcedure>(vector, {
      topK: Math.max(k * RECALL_OVERSCAN, k),
      threshold,
    });

    const prefix = `${this.namespace}.`;

    return hits
      .filter((hit: CacheSimilarHit<StoredProcedure>) =>
        hit.key.startsWith(prefix),
      )
      .map((hit: CacheSimilarHit<StoredProcedure>) => ({
        id: hit.value.id,
        text: hit.value.text,
        tier: "procedural" as const,
        score: this.blend(hit.score, hit.value.uses),
        metadata: hit.value.metadata,
      }))
      .sort((first, second) => second.score - first.score)
      .slice(0, k);
  }

  /** Drop every procedure written under this instance's namespace. */
  public async clear(): Promise<void> {
    await this.store.removeNamespace(this.namespace);
  }

  /**
   * Combine raw similarity with a saturating reinforcement proxy:
   * `(1 - w)·similarity + w·(uses / (uses + 1))`. A first-time procedure
   * contributes `0.5`; each reinforcement nudges it toward `1` with
   * diminishing returns. With `reinforcementWeight` 0 the score is pure
   * similarity.
   */
  private blend(similarity: number, uses: number): number {
    const reinforcement = uses / (uses + 1);

    return (
      (1 - this.reinforcementWeight) * similarity +
      this.reinforcementWeight * reinforcement
    );
  }

  /** Namespaced key for an entry — dot separator, matching `similar()` keys. */
  private keyFor(id: string): string {
    return `${this.namespace}.${id}`;
  }
}
