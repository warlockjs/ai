/**
 * Agent memory core (memory core M1). The canonical access point is
 * `ai.memory(config)`; this barrel exports the factory plus its contract
 * + data-shape types so devs can type their own consumers.
 *
 * Four tiers ship in 4.3.0 — WORKING (in-run scratch), SEMANTIC (durable
 * facts by similarity), EPISODIC (durable events, similarity × recency),
 * and PROCEDURAL (durable how-tos, similarity × reinforcement) over a
 * `@warlock.js/cache` driver. Decay / forgetting remains deferred.
 */
export { memory } from "./memory";

export type { MemoryContract } from "../contracts/memory/memory.contract";
export type {
  EpisodicMemoryConfig,
  MemoryConfig,
  ProceduralMemoryConfig,
  SemanticMemoryConfig,
} from "../contracts/memory/memory-config.type";
export type {
  MemoryItem,
  MemoryTier,
  RecalledMemory,
} from "../contracts/memory/memory-item.type";
export type { RecallOptions } from "../contracts/memory/recall-options.type";
