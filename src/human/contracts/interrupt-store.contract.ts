import type { ApprovalRequest } from "./approval.type";

/**
 * Lifecycle status of a persisted interrupt.
 *
 * `"pending"` until a decision lands; the record is marked
 * `"resolved"` (then deleted) once `ai.human.resume(...)` applies a
 * decision. Discriminator is `status` (a closed string union), so a
 * caller can branch idempotently — a second resume of a `"resolved"`
 * (or already-deleted) interrupt is a no-op, never a double-apply.
 */
export type PendingInterruptStatus = "pending" | "resolved";

/**
 * A persisted, awaiting-decision interrupt — the durable counterpart of
 * an in-flight {@link ApprovalRequest}.
 *
 * Mirrors the shape the snapshot/checkpoint stores persist: a flat
 * record keyed by a single id (`interruptId`) that the store round-trips
 * verbatim. The `request` is everything a reviewer (in another process,
 * hours later) needs to rule on the call; `status` tracks the lifecycle;
 * `savedAt` is the ISO-8601 write time.
 */
export interface PendingInterrupt {
  /** Stable id; the store keys the record on it. */
  interruptId: string;

  /** The pending call the human is asked to rule on. */
  request: ApprovalRequest;

  /** `"pending"` until a decision lands; then `"resolved"` and deleted. */
  status: PendingInterruptStatus;

  /** When the record was written, as an ISO-8601 timestamp. */
  savedAt: string;
}

/**
 * Durable store for {@link PendingInterrupt} records — the persistence
 * seam behind durable human-in-the-loop approval.
 *
 * Deliberately shaped like the `@warlock.js/ai`
 * `SnapshotStore` / `CheckpointStore` contracts (`load` / `save` /
 * `delete` / optional `list` / `schema`), so a consumer already running
 * an orchestrator can reuse the **same** `pg.Pool` / redis client for
 * the interrupt table. Keyed by `interruptId`. Schema is never
 * auto-migrated — {@link InterruptStore.schema} returns a DDL string the
 * dev runs through their own migration tooling.
 *
 * Implementations: `ai.human.interrupt.{memory,pg,redis}()`. The memory
 * impl ships first (pure in-process `Map`, zero deps); pg/redis lazily
 * import their client via {@link PgClientLike} / {@link RedisClientLike}
 * so neither driver is a hard dependency.
 */
export interface InterruptStore {
  /**
   * Persist a pending interrupt, keyed by its own `interruptId`.
   * Overwrites any prior record for the same id (a call has exactly one
   * live interrupt).
   */
  save(record: PendingInterrupt): Promise<void>;

  /**
   * Load the interrupt for an `interruptId`, or `undefined` when none is
   * recorded (never raised, or already resolved + deleted).
   */
  load(interruptId: string): Promise<PendingInterrupt | undefined>;

  /**
   * Drop the interrupt for an `interruptId`. Idempotent — deleting an
   * absent id is a no-op.
   */
  delete(interruptId: string): Promise<void>;

  /**
   * List the interrupt ids the store knows, optionally filtered by a
   * prefix. Optional — stores that can't enumerate (e.g. a key/value
   * driver with no `SCAN`) omit it.
   */
  list?(prefix?: string): Promise<string[]>;

  /**
   * Return the DDL string for this store's backing table. The dev runs
   * it through their migration tool; the framework never auto-migrates.
   * Stores with no backing table (memory, redis) return an empty string
   * so callers can treat `schema()` uniformly across drivers.
   */
  schema(): string;
}

/**
 * Minimal `pg`-compatible client surface the Postgres
 * {@link InterruptStore} depends on. Both `pg.Pool` and `pg.Client`
 * satisfy it — the store only ever calls `query`.
 *
 * `@warlock.js/ai` takes **no** hard dependency on `pg`; the dev
 * installs it (an optional peer) and passes the client in. Structurally
 * identical to the orchestrator stores' `PgClientLike`, so a single pool
 * can back the checkpoint/snapshot stores and the interrupt table alike.
 */
export interface PgClientLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Minimal `redis`-compatible client surface the Redis
 * {@link InterruptStore} depends on.
 *
 * `@warlock.js/ai` takes **no** hard dependency on `redis`; the dev
 * installs it (an optional peer) and passes the connected client in. The
 * store only calls `get` / `set` / `del`.
 */
export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(key: string): Promise<number>;
}
