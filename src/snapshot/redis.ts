import type {
  RedisClientLike,
  SnapshotStore,
} from "../contracts/orchestrator/snapshot-store.contract";
import type { SupervisorSnapshot } from "../contracts/supervisor/supervisor-snapshot.type";

/**
 * Default key prefix the redis store prepends to each `runId`. Namespaces
 * the snapshot keys so they coexist with other data in the same Redis
 * database without collision.
 */
const DEFAULT_PREFIX = "warlock:supervisor:snapshot:";

/**
 * Options for {@link redis}. The `client` is an already-connected redis
 * client (anything satisfying {@link RedisClientLike}); the store never
 * connects or quits it — connection lifecycle stays with the caller.
 */
export type RedisSnapshotStoreOptions = {
  /** Pre-connected redis client. The store only calls `get`/`set`/`del`. */
  client: RedisClientLike;
  /**
   * Key prefix prepended to each `runId`. Defaults to
   * `warlock:supervisor:snapshot:`.
   */
  prefix?: string;
};

/**
 * Redis {@link SnapshotStore} — supervisor run snapshots persisted as one
 * JSON string value per `runId`, under a namespaced key (orchestrator.md
 * §8).
 *
 * Owns: durable round-tripping of the {@link SupervisorSnapshot} envelope
 * keyed by `runId`, so a crashed mid-turn `iterate: true` iteration can
 * resume after a restart. Does NOT own: the connection (the caller passes
 * a live client and keeps owning its lifecycle) or enumeration — the
 * structural {@link RedisClientLike} surface exposes only `get`/`set`/
 * `del`, with no `SCAN`/`KEYS`, so `list()` is intentionally not
 * implemented (the contract allows stores that can't enumerate to omit
 * it). Pair it with a {@link import("../contracts/orchestrator/checkpoint-store.contract").CheckpointStore}
 * for the boot-drain loop, which is where enumeration is actually needed.
 *
 * `save()` overwrites the key — a run has exactly one live snapshot.
 * Redis needs no schema, so {@link RedisSnapshotStore.schema} returns an
 * empty string for uniformity with the other drivers.
 *
 * Front it with the {@link redis} factory — callers never `new` it.
 */
class RedisSnapshotStore implements SnapshotStore {
  /** The user-supplied redis client. Only `get`/`set`/`del` are called. */
  private readonly client: RedisClientLike;

  /** Key prefix prepended to each `runId`. */
  private readonly prefix: string;

  public constructor(options: RedisSnapshotStoreOptions) {
    if (
      !options ||
      !options.client ||
      typeof options.client.get !== "function" ||
      typeof options.client.set !== "function" ||
      typeof options.client.del !== "function"
    ) {
      throw new Error(
        "Redis snapshot store requires a 'client' option implementing { get, set, del } — pass a connected redis client.",
      );
    }

    this.client = options.client;
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
  }

  /**
   * Build the namespaced Redis key for a `runId`.
   */
  private key(runId: string): string {
    return `${this.prefix}${runId}`;
  }

  /**
   * Load the snapshot for a `runId`, or `undefined` when the key is
   * missing. Redis returns `null` for an absent key — converted to
   * `undefined` at the boundary.
   */
  public async load(runId: string): Promise<SupervisorSnapshot | undefined> {
    const value = await this.client.get(this.key(runId));

    if (value === null) {
      return undefined;
    }

    return JSON.parse(value) as SupervisorSnapshot;
  }

  /**
   * Persist a snapshot, keyed by its own `runId`. Overwrites any prior
   * snapshot for the same run — a run has exactly one live snapshot.
   */
  public async save(snapshot: SupervisorSnapshot): Promise<void> {
    await this.client.set(this.key(snapshot.runId), JSON.stringify(snapshot));
  }

  /**
   * Drop the snapshot for a `runId`.
   */
  public async delete(runId: string): Promise<void> {
    await this.client.del(this.key(runId));
  }

  /**
   * Redis needs no backing table — there is nothing to migrate. Returns
   * an empty string so callers can treat `schema()` uniformly across
   * drivers.
   */
  public schema(): string {
    return "";
  }
}

/**
 * Create a Redis-backed {@link SnapshotStore}. Pass a connected redis
 * client — the store never connects or quits it.
 *
 * Note: this store does not implement the optional `list()` — the
 * structural client surface has no `SCAN`/`KEYS`. Use a checkpoint store
 * for the production boot-drain loop where enumeration is needed.
 *
 * @example
 * import { createClient } from "redis";
 * import { ai } from "@warlock.js/ai";
 *
 * const client = createClient({ url: process.env.REDIS_URL });
 * await client.connect();
 *
 * const orchestrator = ai.orchestrator({
 *   name: "support",
 *   intents: { ... },
 *   iterate: true,
 *   snapshotStore: ai.snapshot.redis({ client }),
 * });
 */
export function redis(options: RedisSnapshotStoreOptions): SnapshotStore {
  return new RedisSnapshotStore(options);
}
