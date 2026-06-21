/**
 * Memory-core contracts (memory core M1). The `MemoryContract` plus its
 * data-shape types — the public surface devs type their own stores and
 * recall results against. The `memory(config)` factory that implements
 * the contract lives under `src/memory`.
 *
 * Episodic / procedural tiers and decay are DEFERRED to 4.4 — the
 * {@link MemoryTier} union is closed to the v1 pair so the addition is
 * non-breaking.
 */
export type { MemoryContract } from "./memory.contract";
export type {
  MemoryConfig,
  SemanticMemoryConfig,
} from "./memory-config.type";
export type {
  MemoryItem,
  MemoryTier,
  RecalledMemory,
} from "./memory-item.type";
export type { RecallOptions } from "./recall-options.type";
