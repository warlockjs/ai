import type { MemoryTier } from "./memory-item.type";

/**
 * Options for `memory.recall(query, options?)`.
 *
 * All fields are optional — the common call is `recall("some query")`,
 * which uses the factory-configured `k` and threshold against every
 * configured tier.
 */
export type RecallOptions = {
  /**
   * Maximum number of memories to return. Overrides the factory's `k`
   * for this call. The result is the top-`k` across whichever tiers are
   * queried, ordered by descending `score`.
   */
  k?: number;
  /**
   * Restrict recall to a single tier. Omit to query every tier the
   * factory was configured with (working first, then semantic) and
   * merge the results.
   */
  tier?: MemoryTier;
  /**
   * Minimum semantic similarity for a hit, in `[0, 1]`. Overrides the
   * factory's `threshold` for this call. Ignored by the working tier,
   * which has no vector index.
   */
  threshold?: number;
};
