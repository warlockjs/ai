import type { MemoryItem, MemoryTier, RecalledMemory } from "./memory-item.type";
import type { RecallOptions } from "./recall-options.type";

/**
 * Provider-neutral contract for an agent memory store (memory core M1).
 *
 * **Role.** A single store that holds and retrieves what an agent /
 * orchestrator should remember across turns. Four tiers ship in 4.3.0:
 *
 * - **working** — in-run scratch the orchestrator threads across turns
 *   of one session. Volatile, unscored, recalled in insertion order.
 * - **semantic** — durable *facts* stored as embeddings in a
 *   `@warlock.js/cache` driver, retrieved by cosine similarity via the
 *   driver's `.similar()` (the same delegation the `semanticCache`
 *   middleware uses).
 * - **episodic** — durable *events*: a timestamped log retrieved by
 *   similarity blended with recency, so recent episodes outrank stale
 *   ones at equal relevance.
 * - **procedural** — durable *how-tos*: learned procedures retrieved by
 *   similarity blended with reinforcement, so a procedure re-affirmed
 *   more often outranks a one-off.
 *
 * `recall()` returns {@link RecalledMemory}[] — scored entries the
 * caller injects into the model context (system prefix, a synthesized
 * "what you remember" block, etc.). Memory never mutates the prompt
 * itself; surfacing the recalled text is the consumer's call so the
 * injection point stays explicit.
 *
 * **Isolation (4.15.0).** Every item may carry a `scope` — an opaque
 * tenant / session / user key — and every `recall()` may name one. The
 * match is exact equality, enforced *inside* each tier before hits are
 * scored and merged, so one scope's memories can never surface in
 * another's recall. Unscoped items form a shared pool readable only by an
 * equally unscoped `recall()`; there is no "read every scope" query.
 * `ai.orchestrator({ memory })` sets this automatically from the turn's
 * `sessionId` (see `OrchestratorMemoryConfig.scope`).
 *
 * **Still deferred.** Decay / forgetting (TTL-based relevance falloff,
 * eviction policies) is not yet implemented; the four tiers above are the
 * full 4.3.0 surface. The `episodic` and `procedural` tiers were added in
 * 4.3.0 as a non-breaking widening of the {@link MemoryTier} union.
 *
 * Front it with the `memory(config)` factory — callers never `new` an
 * implementation.
 *
 * @example
 * import { ai } from "@warlock.js/ai";
 * import { MemoryCacheDriver } from "@warlock.js/cache";
 *
 * const store = new MemoryCacheDriver();
 * store.setOptions({});
 *
 * const mem = ai.memory({
 *   semantic: {
 *     embedder: openai.embedder({ name: "text-embedding-3-small" }),
 *     store,
 *   },
 * });
 *
 * await mem.remember({ text: "User prefers metric units.", tier: "semantic" });
 * const hits = await mem.recall("which units does the user like?", { k: 3 });
 */
export interface MemoryContract {
  /** Stable identifier — surfaced in logs and used as the working-tier scope key. */
  readonly name: string;

  /**
   * Store one or more memories. Each item lands in its own `tier` (or
   * the factory's `defaultTier` when unset). Items addressed to the
   * semantic tier are embedded and indexed; working-tier items are
   * appended to the in-run buffer.
   *
   * Re-remembering an item whose id (explicit or text-derived) already
   * exists overwrites it in place rather than duplicating — within the
   * item's `scope`. Identical text under two different scopes stays two
   * independent entries.
   */
  remember(items: MemoryItem | MemoryItem[]): Promise<void>;

  /**
   * Retrieve the memories most relevant to `query`, scored and ordered
   * by descending relevance. Queries every enabled tier by default;
   * `options.tier` narrows to one. `options.k` caps the result count,
   * `options.threshold` raises the semantic-similarity floor, and
   * `options.scope` restricts the eligible set to the memories written
   * under that exact scope (omit it to read the unscoped pool only).
   *
   * Returns an empty array when nothing clears the threshold — never
   * throws on "no hits".
   */
  recall(query: string, options?: RecallOptions): Promise<RecalledMemory[]>;

  /**
   * Forget memories. With no argument, clears every tier. With a `tier`,
   * clears just that tier — e.g. `clear("working")` at the end of a
   * session while leaving durable semantic recall intact.
   */
  clear(tier?: MemoryTier): Promise<void>;
}
