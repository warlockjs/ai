/**
 * Snapshot-store factories. The canonical access point is
 * `ai.snapshot.{memory,pg,redis}()`; this barrel additionally exports
 * each factory under a disambiguated name so it can flow through the root
 * package barrel without colliding with the sibling checkpoint factories.
 */
export { memory as snapshotMemory } from "./memory";
export { pg as snapshotPg, type PgSnapshotStoreOptions } from "./pg";
export { redis as snapshotRedis, type RedisSnapshotStoreOptions } from "./redis";
