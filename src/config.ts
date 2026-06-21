import type { CacheDriver } from "@warlock.js/cache";
import type { CheckpointStore } from "./contracts/orchestrator/checkpoint-store.contract";
import type { SnapshotStore } from "./contracts/orchestrator/snapshot-store.contract";

/**
 * Process-wide `@warlock.js/ai` configuration. **Intentionally tiny.**
 * Lives here only for genuinely cross-cutting defaults that would
 * otherwise force users to wire the same value into every consumer.
 *
 * **What lives here.** A field earns a slot only when it satisfies
 * all three:
 * 1. Multiple unrelated consumers need the same value.
 * 2. The value is infrastructure (drivers, clients, pools), not
 *    behavior (kill-switches, mode flags).
 * 3. Per-call override doesn't make sense for the use case.
 *
 * **What does NOT live here.** Logger config (use
 * `@warlock.js/logger` directly). Per-primitive feature flags
 * (live on the relevant config type). Anything that's really one
 * consumer's concern (lives on that consumer).
 *
 * Phase 3.2 deliberately removed the previous `configureAI()` bag
 * because it was growing unbounded. Treat new fields here with the
 * same suspicion.
 */
export type AIConfig = {
  /**
   * Default `@warlock.js/cache` driver for cache-backed consumers that
   * didn't supply their own `store` — currently the `semanticCache`
   * middleware's vector store. Declaring it once here removes the
   * repetition across middleware declarations.
   *
   * NOT the snapshot-persistence fallback anymore. Supervisor /
   * workflow / orchestrator resume snapshots resolve through
   * {@link AIConfig.defaultSnapshotStore} (a {@link SnapshotStore}),
   * never this driver.
   *
   * Per-declaration overrides (`semanticCache({ store })`) win when
   * supplied. Set this once at app boot, *after* you've constructed
   * your driver.
   *
   * @example
   * import { cache } from "@warlock.js/cache";
   * import { ai } from "@warlock.js/ai";
   *
   * ai.config({
   *   defaultStore: cache.driver("redis", { client: redisClient }),
   * });
   */
  defaultStore?: CacheDriver<any, any>;

  /**
   * Default {@link CheckpointStore} for every orchestrator that didn't
   * supply its own `checkpointStore` (orchestrator.md §15.2). Holds
   * durable session state — `state`, `turn_index`, drift `signature`,
   * compaction locks. Per-orchestrator `checkpointStore` wins when
   * supplied. Set once at app boot.
   *
   * @example
   * import { ai } from "@warlock.js/ai";
   *
   * ai.config({ defaultCheckpointStore: ai.checkpoint.memory() });
   */
  defaultCheckpointStore?: CheckpointStore;

  /**
   * Default {@link SnapshotStore} for every orchestrator that didn't
   * supply its own `snapshotStore` (orchestrator.md §15.2). Holds the
   * internal supervisor run state used to resume an interrupted
   * `iterate: true` turn. Per-orchestrator `snapshotStore` wins when
   * supplied. Set once at app boot.
   *
   * @example
   * import { ai } from "@warlock.js/ai";
   *
   * ai.config({ defaultSnapshotStore: ai.snapshot.memory() });
   */
  defaultSnapshotStore?: SnapshotStore;
};

const aiConfig: AIConfig = {};

/**
 * Set or extend process-wide AI configuration. Merges over existing
 * values — fields not present in `partial` keep whatever was set
 * before (or stay unset). Call once at app boot, before constructing
 * any agent / supervisor / middleware that should pick up the
 * defaults.
 *
 * Returns the merged config so callers can verify what landed.
 *
 * @example
 * import { cache } from "@warlock.js/cache";
 * import { ai } from "@warlock.js/ai";
 *
 * ai.config({ defaultStore: cache.driver("redis", { client }) });
 */
export function setAIConfig(partial: Partial<AIConfig>): AIConfig {
  Object.assign(aiConfig, partial);
  return { ...aiConfig };
}

/**
 * Read the current AI config snapshot. Returns a shallow copy so
 * callers can't accidentally mutate the source of truth. Used
 * internally by consumers to resolve their `defaultStore` fallback.
 */
export function getAIConfig(): AIConfig {
  return { ...aiConfig };
}

/**
 * Resolve the effective `@warlock.js/cache` driver for a cache-backed
 * consumer that didn't receive an explicit one. Returns the global
 * `defaultStore` if set, otherwise `undefined`. The semantic-cache
 * middleware treats `undefined` as fatal and throws. Snapshot
 * persistence no longer consults this — it resolves through
 * {@link resolveDefaultSnapshotStore}.
 */
export function resolveDefaultStore(): CacheDriver<any, any> | undefined {
  return aiConfig.defaultStore;
}

/**
 * Resolve the global default {@link CheckpointStore} for an
 * orchestrator that didn't receive an explicit `checkpointStore`.
 * Returns `undefined` when none is configured — the orchestrator
 * factory decides whether that's fatal.
 */
export function resolveDefaultCheckpointStore(): CheckpointStore | undefined {
  return aiConfig.defaultCheckpointStore;
}

/**
 * Resolve the global default {@link SnapshotStore} for an orchestrator
 * that didn't receive an explicit `snapshotStore`. Returns `undefined`
 * when none is configured — the orchestrator factory decides whether
 * that's fatal (it is, when `iterate: true`).
 */
export function resolveDefaultSnapshotStore(): SnapshotStore | undefined {
  return aiConfig.defaultSnapshotStore;
}
