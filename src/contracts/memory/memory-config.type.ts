import type { CacheDriver } from "@warlock.js/cache";
import type { EmbedderContract } from "../embedder.contract";
import type { MemoryTier } from "./memory-item.type";

/**
 * Semantic-tier wiring for `memory(config)`.
 *
 * Mirrors the `semanticCache` middleware's delegation model: memory does
 * NOT implement similarity search itself — it stores embeddings in a
 * `@warlock.js/cache` driver and retrieves them via the driver's native
 * `.similar()`. Supply the embedder that turns text into vectors and the
 * store that indexes them.
 *
 * Dev / test environments pass `new MemoryCacheDriver()` (zero config,
 * O(N) scan). Production picks a driver with a real ANN index — `pg`
 * with pgvector, `redis` with RediSearch. Drivers without similarity
 * support throw `CacheUnsupportedError` from `set({ vector })` /
 * `similar()`.
 */
export type SemanticMemoryConfig = {
  /** Embedder used to vectorize remembered text and recall queries. */
  embedder: EmbedderContract;
  /**
   * Vector-capable cache driver from `@warlock.js/cache`. Falls back to
   * `ai.config({ defaultStore })` when omitted; the factory throws at
   * construction when neither is available.
   */
  store?: CacheDriver<any, any>;
  /**
   * Namespace prefix applied to every key the semantic tier writes. Lets
   * multiple memory instances share one driver without collision.
   * Default `"ai.memory"`.
   */
  namespace?: string;
};

/**
 * Episodic-tier wiring for `memory(config)`.
 *
 * Like the semantic tier, episodic memory is embedder-backed and stores
 * its vectors in a `@warlock.js/cache` driver — it adds a per-entry
 * timestamp and blends **recency** into the recall score so recent
 * episodes outrank stale ones at equal similarity.
 */
export type EpisodicMemoryConfig = {
  /** Embedder used to vectorize remembered episodes and recall queries. */
  embedder: EmbedderContract;
  /**
   * Vector-capable cache driver. Falls back to `ai.config({ defaultStore })`
   * when omitted; the factory throws at construction when neither exists.
   */
  store?: CacheDriver<any, any>;
  /**
   * Namespace prefix for every key this tier writes. Default
   * `"ai.memory.episodic"`. Keep distinct from sibling tiers when sharing
   * one driver.
   */
  namespace?: string;
  /**
   * How much recency counts versus similarity in the blended score, in
   * `[0, 1]`. `0` = pure similarity (semantic-style); higher favors
   * recent episodes. Default `0.3`.
   */
  recencyWeight?: number;
  /**
   * Age at which an episode's recency contribution halves, in
   * milliseconds. Default 7 days. Larger = slower decay.
   */
  halfLifeMs?: number;
  /**
   * Clock used to stamp + age episodes. Defaults to `Date.now`. Override
   * for deterministic tests or replay.
   */
  now?: () => number;
};

/**
 * Procedural-tier wiring for `memory(config)`.
 *
 * Embedder-backed like the semantic tier, but blends **reinforcement**
 * into the recall score: re-remembering a procedure increments its use
 * count, so well-worn procedures outrank one-offs at equal similarity.
 */
export type ProceduralMemoryConfig = {
  /** Embedder used to vectorize remembered procedures and recall queries. */
  embedder: EmbedderContract;
  /**
   * Vector-capable cache driver. Falls back to `ai.config({ defaultStore })`
   * when omitted; the factory throws at construction when neither exists.
   */
  store?: CacheDriver<any, any>;
  /**
   * Namespace prefix for every key this tier writes. Default
   * `"ai.memory.procedural"`. Keep distinct from sibling tiers when
   * sharing one driver.
   */
  namespace?: string;
  /**
   * How much reinforcement counts versus similarity in the blended score,
   * in `[0, 1]`. `0` = pure similarity; higher favors well-used
   * procedures. Default `0.3`.
   */
  reinforcementWeight?: number;
};

/**
 * Configuration for the `memory(config)` factory.
 *
 * At least one tier must be enabled. The working tier is on by default
 * (`working: true`); the semantic, episodic, and procedural tiers each
 * activate only when their config is supplied. Enabling neither is a
 * construction-time error — a memory with no tiers can't store or recall
 * anything.
 */
export type MemoryConfig = {
  /** Stable identifier — used in logs and as the working-tier scope key. */
  name?: string;
  /**
   * Enable the in-run working tier. Default `true`. Set `false` to build
   * a semantic-only memory.
   */
  working?: boolean;
  /**
   * Enable + wire the semantic recall tier. Omit for a working-only
   * memory.
   */
  semantic?: SemanticMemoryConfig;
  /**
   * Enable + wire the episodic tier — durable, recency-blended recall of
   * timestamped events. Omit to leave it off.
   */
  episodic?: EpisodicMemoryConfig;
  /**
   * Enable + wire the procedural tier — durable, reinforcement-blended
   * recall of learned how-tos. Omit to leave it off.
   */
  procedural?: ProceduralMemoryConfig;
  /**
   * Tier a `remember(...)` item lands in when it doesn't name its own
   * `tier`. Default `"working"`. Must reference an enabled tier.
   */
  defaultTier?: MemoryTier;
  /**
   * Default number of memories `recall(...)` returns when the call
   * doesn't override `k`. Default `5`.
   */
  k?: number;
  /**
   * Default minimum semantic similarity for a recall hit, in `[0, 1]`.
   * Default `0.7`. Ignored by the working tier.
   */
  threshold?: number;
};
