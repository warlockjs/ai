import type {
  CheckpointRecord,
  CheckpointStore,
} from "../contracts/orchestrator/checkpoint-store.contract";
import type { RedisClientLike } from "../contracts/orchestrator/snapshot-store.contract";

/**
 * Options for the Redis {@link CheckpointStore} (orchestrator.md §8.3).
 *
 * The dev owns the connection — `@warlock.js/ai` takes no peer dep on
 * `redis` and never opens or closes the client.
 */
export type RedisCheckpointOptions = {
  /** An already-connected `redis` client — anything matching {@link RedisClientLike}. */
  client: RedisClientLike;
  /**
   * Key prefix for every key this store writes. Lets one Redis database
   * back multiple stores without collision. Defaults to
   * `warlock:orchestrator`.
   */
  prefix?: string;
  /** Idle-key TTL in seconds. When set, every written key expires after the TTL. */
  ttl?: number;
};

/**
 * Default key prefix — namespaces the store's keys inside a shared
 * Redis database.
 */
const DEFAULT_PREFIX = "warlock:orchestrator";

/**
 * Per-session document persisted under one Redis key: the append-only
 * list of {@link CheckpointRecord} rows in turn order, mirroring the
 * Postgres append-only PK shape (§8.6) inside a single JSON value so
 * the store needs only `get`/`set`/`del` from {@link RedisClientLike}.
 */
type SessionDocument = {
  rows: CheckpointRecord[];
};

/**
 * Per-orchestrator index document: the set of live session ids. Kept as
 * a JSON array because {@link RedisClientLike} exposes no `keys` / `scan`
 * — enumeration for the §9.3 boot drain must be self-maintained.
 */
type IndexDocument = {
  sessionIds: string[];
};

/**
 * Redis-backed {@link CheckpointStore} (orchestrator.md §8.2).
 *
 * Owns: the per-session append-only document, a per-orchestrator
 * session-id index (so {@link RedisCheckpointStore.list} works without
 * `KEYS`/`SCAN`), the "latest turn wins" load, and the §4-Phase-6
 * retention prune. Does NOT own: durability guarantees beyond Redis's
 * own, the connection lifecycle (the dev passes a client), or the
 * `keepSnapshots` policy (that lives on the orchestrator config).
 *
 * Because {@link RedisClientLike} is intentionally minimal (`get` /
 * `set` / `del` only — §8.4), the store models a session as a single
 * JSON document rather than one Redis key per turn. This keeps every
 * operation a single round-trip and avoids depending on key scanning,
 * at the cost of read-modify-write on `save`. Callers must serialize
 * traffic per `sessionId` anyway (§17 "two turns racing"), so the
 * read-modify-write is safe under that contract.
 *
 * Front it with the {@link redis} factory — callers never `new` it.
 */
class RedisCheckpointStore implements CheckpointStore {
  /** The dev-supplied redis client. Never disconnected by the store. */
  private readonly client: RedisClientLike;

  /** Key prefix namespacing every key this store writes. */
  private readonly prefix: string;

  /** Idle-key TTL in seconds, or `undefined` for no expiry. */
  private ttl?: number;

  public constructor(options: RedisCheckpointOptions) {
    if (
      !options ||
      typeof options.client?.get !== "function" ||
      typeof options.client?.set !== "function" ||
      typeof options.client?.del !== "function"
    ) {
      throw new TypeError(
        "ai.checkpoint.redis requires a 'client' option implementing { get, set, del } — pass a connected redis client.",
      );
    }

    this.client = options.client;
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
    this.ttl = options.ttl;
  }

  /**
   * Return the latest checkpoint (highest `turn_index`) for a session,
   * or `undefined` when the session has no document. Rows are appended
   * in turn order, so the last element is the latest.
   */
  public async load(
    orchestratorName: string,
    sessionId: string,
  ): Promise<CheckpointRecord | undefined> {
    const document = await this.readSession(orchestratorName, sessionId);

    if (!document || document.rows.length === 0) {
      return undefined;
    }

    return document.rows[document.rows.length - 1];
  }

  /**
   * Append a checkpoint row to its session document, creating the
   * document and indexing the session id on first write. Append-only —
   * an existing `turn_index` is never overwritten; a fresh row is
   * pushed (§4 Phase 6, Q15).
   */
  public async save(record: CheckpointRecord): Promise<void> {
    const { orchestrator_name, session_id } = record;

    const document =
      (await this.readSession(orchestrator_name, session_id)) ?? { rows: [] };

    document.rows.push(record);

    await this.writeSession(orchestrator_name, session_id, document);
    await this.indexSession(orchestrator_name, session_id);
  }

  /**
   * Drop a session document and de-index its session id.
   */
  public async delete(
    orchestratorName: string,
    sessionId: string,
  ): Promise<void> {
    await this.client.del(this.sessionKey(orchestratorName, sessionId));
    await this.deindexSession(orchestratorName, sessionId);
  }

  /**
   * List the session ids known for an orchestrator, optionally filtered
   * by a session-id prefix. Reads the self-maintained index document
   * (§9.3 boot drain).
   */
  public async list(
    orchestratorName: string,
    prefix?: string,
  ): Promise<string[]> {
    const index = await this.readIndex(orchestratorName);

    if (prefix === undefined) {
      return [...index.sessionIds];
    }

    return index.sessionIds.filter((sessionId) =>
      sessionId.startsWith(prefix),
    );
  }

  /**
   * Prune retained turns for a session down to the most recent
   * `keepSnapshots` rows (orchestrator.md §4 Phase 6 / §15.2). Drops
   * every row whose `turn_index` is below `(max_turn_index -
   * keepSnapshots)`. The orchestrator calls this synchronously after a
   * successful {@link save} when `keepSnapshots` is a finite number;
   * `"all"` retention skips the call. Additive to the
   * {@link CheckpointStore} contract — the policy stays on the
   * orchestrator and the store only executes the bounded trim.
   */
  public async prune(
    orchestratorName: string,
    sessionId: string,
    keepSnapshots: number,
  ): Promise<void> {
    if (!Number.isFinite(keepSnapshots) || keepSnapshots < 0) {
      return;
    }

    const document = await this.readSession(orchestratorName, sessionId);

    if (!document || document.rows.length === 0) {
      return;
    }

    const maxTurnIndex = document.rows[document.rows.length - 1].turn_index;
    const threshold = maxTurnIndex - keepSnapshots;

    const kept = document.rows.filter((row) => row.turn_index >= threshold);

    if (kept.length === document.rows.length) {
      return;
    }

    await this.writeSession(orchestratorName, sessionId, { rows: kept });
  }

  /**
   * The Redis store has no relational table — there is nothing to
   * migrate. Returns an empty string so callers can treat `schema()`
   * uniformly across drivers (mirrors the memory store).
   */
  public schema(): string {
    return "";
  }

  /**
   * Set the idle-key TTL (§8.2). Applied on every subsequent write; the
   * store never opens a background timer.
   */
  public setOptions(options: { ttl?: number }): void {
    this.ttl = options.ttl;
  }

  /**
   * Read and parse a session document, or `undefined` when the key is
   * absent.
   */
  private async readSession(
    orchestratorName: string,
    sessionId: string,
  ): Promise<SessionDocument | undefined> {
    const raw = await this.client.get(
      this.sessionKey(orchestratorName, sessionId),
    );

    if (raw === null) {
      return undefined;
    }

    return JSON.parse(raw) as SessionDocument;
  }

  /**
   * Serialize and persist a session document, honoring the configured
   * idle TTL when set.
   */
  private async writeSession(
    orchestratorName: string,
    sessionId: string,
    document: SessionDocument,
  ): Promise<void> {
    await this.write(
      this.sessionKey(orchestratorName, sessionId),
      JSON.stringify(document),
    );
  }

  /**
   * Read and parse the per-orchestrator index document, defaulting to an
   * empty index when absent.
   */
  private async readIndex(orchestratorName: string): Promise<IndexDocument> {
    const raw = await this.client.get(this.indexKey(orchestratorName));

    if (raw === null) {
      return { sessionIds: [] };
    }

    return JSON.parse(raw) as IndexDocument;
  }

  /**
   * Add a session id to the per-orchestrator index, no-op when already
   * present.
   */
  private async indexSession(
    orchestratorName: string,
    sessionId: string,
  ): Promise<void> {
    const index = await this.readIndex(orchestratorName);

    if (index.sessionIds.includes(sessionId)) {
      return;
    }

    index.sessionIds.push(sessionId);

    await this.write(this.indexKey(orchestratorName), JSON.stringify(index));
  }

  /**
   * Remove a session id from the per-orchestrator index, no-op when
   * absent.
   */
  private async deindexSession(
    orchestratorName: string,
    sessionId: string,
  ): Promise<void> {
    const index = await this.readIndex(orchestratorName);
    const next = index.sessionIds.filter((id) => id !== sessionId);

    if (next.length === index.sessionIds.length) {
      return;
    }

    await this.write(
      this.indexKey(orchestratorName),
      JSON.stringify({ sessionIds: next }),
    );
  }

  /**
   * Write a key, attaching the `EX` expiry option when an idle TTL is
   * configured. The TTL flows through {@link RedisClientLike.set}'s
   * variadic args as node-redis's `{ EX }` option object.
   */
  private async write(key: string, value: string): Promise<void> {
    if (this.ttl !== undefined && this.ttl > 0) {
      await this.client.set(key, value, { EX: this.ttl });

      return;
    }

    await this.client.set(key, value);
  }

  /**
   * Key for a session document — `<prefix>:session:<name>:<sessionId>`.
   */
  private sessionKey(orchestratorName: string, sessionId: string): string {
    return `${this.prefix}:session:${orchestratorName}:${sessionId}`;
  }

  /**
   * Key for a per-orchestrator session-id index —
   * `<prefix>:index:<name>`.
   */
  private indexKey(orchestratorName: string): string {
    return `${this.prefix}:index:${orchestratorName}`;
  }
}

/**
 * Create a Redis-backed {@link CheckpointStore} (orchestrator.md §8.3).
 * The dev installs `redis` and passes a connected client —
 * `@warlock.js/ai` never imports `redis`. {@link CheckpointStore.schema}
 * returns an empty string; Redis needs no migration.
 *
 * @example
 * import { createClient } from "redis";
 * import { ai } from "@warlock.js/ai";
 *
 * const client = createClient();
 * await client.connect();
 *
 * const store = ai.checkpoint.redis({ client });
 */
export function redis(options: RedisCheckpointOptions): CheckpointStore {
  return new RedisCheckpointStore(options);
}
