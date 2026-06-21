import type { SupervisorSnapshot } from "../supervisor/supervisor-snapshot.type";

/**
 * Minimal `pg`-compatible client surface the pg snapshot/checkpoint
 * stores depend on (orchestrator.md §8.4). Both `pg.Pool` and
 * `pg.Client` satisfy it — the stores only ever call `query`.
 *
 * `@warlock.js/ai` takes NO peer dep on `pg`; the dev installs it and
 * passes the client in. Mirrors `@warlock.js/cache`'s `PgClientLike`
 * so a single pool can back both the cache and the orchestrator
 * stores. Declared here for the deferred Phase-2 pg drivers.
 */
export type PgClientLike = {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
};

/**
 * Minimal `redis`-compatible client surface the redis snapshot/
 * checkpoint stores depend on (orchestrator.md §8.4).
 *
 * `@warlock.js/ai` takes NO peer dep on `redis`; the dev installs it
 * and passes the client in. Declared here for the deferred Phase-2
 * redis drivers.
 */
export type RedisClientLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(key: string): Promise<number>;
};

/**
 * Durable store for the internal supervisor run state of an
 * `iterate: true` orchestrator turn (orchestrator.md §8.2).
 *
 * Its payload is the existing {@link SupervisorSnapshot} envelope
 * (§8.1 — "same shape as supervisor's existing snapshot envelope"):
 * the store is keyed by the supervisor `runId` and round-trips the
 * whole snapshot, so a crashed mid-turn iteration can resume.
 * **Promoted** from the historical `CacheDriver` path for naming
 * consistency — the `CacheDriver` overload stays for one deprecated
 * minor (§8.1).
 *
 * Distinct from
 * {@link import("./checkpoint-store.contract").CheckpointStore}, which
 * persists cross-turn session state. Implementations:
 * `ai.snapshot.{memory,pg,redis}()`. The memory impl ships in v1;
 * pg/redis follow. Schema is never auto-migrated — {@link
 * SnapshotStore.schema} returns a DDL string the dev runs themselves
 * (§8.5).
 *
 * Generic over the persisted snapshot shape. Defaults to
 * {@link SupervisorSnapshot} so every existing reference resolves
 * exactly as before; the workflow engine parameterizes it with
 * `WorkflowSnapshot`. The only structural requirement is a `runId`
 * string — the store derives its key from it.
 */
export interface SnapshotStore<TSnapshot extends { runId: string } = SupervisorSnapshot> {
  /**
   * Load the snapshot for a `runId`, or `undefined` when no in-flight
   * run is recorded.
   */
  load(runId: string): Promise<TSnapshot | undefined>;

  /**
   * Persist a snapshot. The key is derived from `snapshot.runId` — the
   * store owns its own keying/prefix.
   */
  save(snapshot: TSnapshot): Promise<void>;

  /**
   * Delete the snapshot for a `runId`.
   */
  delete(runId: string): Promise<void>;

  /**
   * List the run ids the store knows, optionally filtered by a prefix.
   * Optional — stores that can't enumerate omit it.
   */
  list?(prefix?: string): Promise<string[]>;

  /**
   * Return the DDL string for this store's backing table. The dev runs
   * it through their migration tool; the framework never auto-migrates
   * (§8.5).
   */
  schema(): string;
}
