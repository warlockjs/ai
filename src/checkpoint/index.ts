/**
 * Checkpoint-store factories. The canonical access point is
 * `ai.checkpoint.{memory,pg,redis}()`; this barrel additionally exports
 * each factory under a disambiguated name so it can flow through the root
 * package barrel without colliding with the sibling snapshot factories.
 */
export { memory as checkpointMemory } from "./memory";
export { pg as checkpointPg, type PgCheckpointOptions } from "./pg";
export { redis as checkpointRedis, type RedisCheckpointOptions } from "./redis";
