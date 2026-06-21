/**
 * The four memory tiers shipped in 4.3.0.
 *
 * - `"working"` — in-run scratch the orchestrator threads across turns.
 *   Volatile, unscored, retrieved in insertion order (recency proxy).
 * - `"semantic"` — durable *facts*, stored as embeddings in a
 *   `@warlock.js/cache` driver, retrieved by cosine similarity.
 * - `"episodic"` — durable *events*: a timestamped log retrieved by
 *   similarity **blended with recency**, so recent episodes outrank stale
 *   ones at equal relevance.
 * - `"procedural"` — durable *how-tos*: learned procedures retrieved by
 *   similarity **blended with reinforcement**, so a procedure remembered
 *   (re-affirmed) more often outranks a one-off at equal relevance.
 *
 * `working` + `semantic` need no extra wiring (semantic needs an embedder
 * + store); `episodic` and `procedural` are embedder-backed like
 * semantic. Decay / forgetting (TTL-based relevance falloff, eviction)
 * remains DEFERRED. The union widened from the v1 `working | semantic`
 * pair to add the two new tiers — a non-breaking change, since every
 * prior value is still valid.
 */
export type MemoryTier = "working" | "semantic" | "episodic" | "procedural";

/**
 * A single unit a caller hands to `memory.remember(...)`.
 *
 * `text` is the only required field — it is what gets embedded for the
 * semantic tier and what is surfaced back on recall. `tier` selects the
 * destination; omit it to fall back to the factory's `defaultTier`.
 *
 * `id` lets a caller address an entry for later overwrite / dedup. When
 * absent the factory derives a stable id from the text so re-remembering
 * identical text updates in place rather than duplicating.
 *
 * `metadata` is an opaque bag round-tripped verbatim onto the recalled
 * memory — use it for source ids, timestamps, tags, or anything the
 * consumer wants back alongside the text.
 */
export type MemoryItem = {
  /** Natural-language content. Embedded for semantic recall; surfaced verbatim on retrieval. */
  text: string;
  /** Destination tier. Defaults to the factory's `defaultTier` when omitted. */
  tier?: MemoryTier;
  /** Caller-owned identifier for overwrite / dedup. Derived from `text` when omitted. */
  id?: string;
  /** Opaque metadata round-tripped onto the recalled memory unchanged. */
  metadata?: Record<string, unknown>;
};

/**
 * A memory returned from `memory.recall(...)`, carrying the relevance
 * `score` the retrieval assigned it.
 *
 * `score` is in `[0, 1]` for every tier so a consumer can sort a mixed
 * recall set on one field without special-casing the tier: cosine
 * similarity for `semantic`, a recency proxy for `working` (most-recent =
 * 1), similarity blended with recency for `episodic`, and similarity
 * blended with reinforcement for `procedural`.
 */
export type RecalledMemory = {
  /** Stable id of the stored memory. */
  id: string;
  /** The remembered text, surfaced for injection into context. */
  text: string;
  /** Which tier produced this hit. */
  tier: MemoryTier;
  /** Relevance in `[0, 1]` — cosine similarity (semantic) or recency proxy (working). */
  score: number;
  /** Opaque metadata stored alongside the memory, returned verbatim. */
  metadata?: Record<string, unknown>;
};
