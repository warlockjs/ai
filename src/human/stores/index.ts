/**
 * {@link import("../contracts/interrupt-store.contract").InterruptStore}
 * factories. The canonical access point is
 * `ai.human.interrupt.{memory,pg,redis}()`; this barrel re-exports each
 * factory under a disambiguated name so it can flow through the root
 * package barrel and be re-grouped onto the `ai.human.interrupt` namespace
 * without colliding with sibling factories.
 *
 * The memory impl ships real (pure in-process `Map`, zero deps); the
 * `pg` / `redis` impls lazily import their driver via the structural
 * {@link import("../contracts/interrupt-store.contract").PgClientLike} /
 * {@link import("../contracts/interrupt-store.contract").RedisClientLike}
 * interfaces, so neither is a hard dependency.
 */
export { memory as interruptMemory } from "./memory";
export { pg as interruptPg, type PgInterruptOptions } from "./pg";
export { redis as interruptRedis, type RedisInterruptOptions } from "./redis";
