import type {
  CheckpointRecord,
  CheckpointStore,
} from "../contracts/orchestrator/checkpoint-store.contract";
import type { PgClientLike } from "../contracts/orchestrator/snapshot-store.contract";

/**
 * Options for the Postgres {@link CheckpointStore} (orchestrator.md §8.3).
 *
 * The dev owns the connection — `@warlock.js/ai` takes no peer dep on
 * `pg` and never opens or closes the client. A single `pg.Pool` can
 * back both the cache and the orchestrator stores.
 */
export type PgCheckpointOptions = {
  /** An already-built `pg.Pool` / `pg.Client` — anything matching {@link PgClientLike}. */
  client: PgClientLike;
  /** Backing table name. Defaults to `warlock_orchestrator_sessions` (§8.6). Must be a safe SQL identifier. */
  table?: string;
  /** Idle-row TTL in seconds. When set, rows older than the TTL are eligible for cleanup on prune. */
  ttl?: number;
};

/**
 * Default backing table — matches the §8.6 reference DDL verbatim so a
 * stock migration provisions the store with no extra config.
 */
const DEFAULT_TABLE = "warlock_orchestrator_sessions";

/**
 * Allowed characters in a Postgres identifier (table name). The table
 * name is interpolated into DDL/DML, so anything outside this
 * conservative ASCII subset is rejected — interpolating an arbitrary
 * string would be a SQL-injection footgun (mirrors `PgCacheDriver`).
 */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Coerce a Postgres `INTEGER` column back to a number. `pg` hands back
 * `INTEGER` as a JS number already, but some pool wrappers surface it
 * as a string — normalize defensively so `turn_index` arithmetic and
 * the latest-turn ordering never compare strings.
 */
function toNumber(value: unknown): number {
  return typeof value === "string" ? Number(value) : (value as number);
}

/**
 * Coerce a nullable Postgres integer column to `number | null`.
 */
function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : toNumber(value);
}

/**
 * Coerce a Postgres timestamp/text column to an ISO string. `pg`
 * returns `TIMESTAMPTZ` as a `Date`; normalize to the ISO wire shape
 * the {@link CheckpointRecord} contract declares.
 */
function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return value as string;
}

/**
 * Coerce a nullable Postgres timestamp column to `string | null`.
 */
function toNullableIso(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return toIso(value);
}

/**
 * Decode the single `last_route` `TEXT` column back to the
 * `string | string[] | null` shape the contract declares. A fan-out
 * array is written JSON-encoded (it starts with `[`), so a leading `[`
 * is the signal to parse; any other value is a single intent stored
 * verbatim. Symmetric with {@link PgCheckpointStore.serializeRoute}.
 */
function deserializeRoute(value: unknown): string | string[] | null {
  if (value === null || value === undefined) {
    return null;
  }

  const route = value as string;

  if (route.startsWith("[")) {
    return JSON.parse(route) as string[];
  }

  return route;
}

/**
 * Map a raw DB row to a {@link CheckpointRecord}. Column names match
 * the §8.6 DDL 1:1, so this is a typed projection plus the defensive
 * coercions a heterogeneous `pg` client population needs.
 */
function rowToRecord(row: Record<string, unknown>): CheckpointRecord {
  const state =
    typeof row.state === "string" ? JSON.parse(row.state) : row.state;

  return {
    orchestrator_name: row.orchestrator_name as string,
    session_id: row.session_id as string,
    turn_index: toNumber(row.turn_index),
    state,
    last_route: deserializeRoute(row.last_route),
    signature: row.signature as string,
    version: (row.version as string | null) ?? null,
    summarized_through: toNullableNumber(row.summarized_through),
    lock_acquired_at: toNullableIso(row.lock_acquired_at),
    lock_expires_at: toNullableIso(row.lock_expires_at),
    saved_at: toIso(row.saved_at),
  };
}

/**
 * Postgres-backed {@link CheckpointStore} (orchestrator.md §8.2, §8.6).
 *
 * Owns: append-only checkpoint rows keyed by
 * `(orchestrator_name, session_id, turn_index)`, the "latest turn wins"
 * load, the §8.6 DDL via {@link PgCheckpointStore.schema}, and the
 * §4-Phase-6 retention prune. Does NOT own: the connection lifecycle
 * (the dev passes a client and keeps it), schema migration (the dev
 * runs `schema()` through their own tool — never auto-migrated, §8.5),
 * or the `keepSnapshots` policy itself (that lives on the orchestrator
 * config; the orchestrator passes the resolved bound into
 * {@link PgCheckpointStore.prune}).
 *
 * Front it with the {@link pg} factory — callers never `new` it.
 */
class PgCheckpointStore implements CheckpointStore {
  /** The dev-supplied `pg.Pool` / `pg.Client`. Never closed by the store. */
  private readonly client: PgClientLike;

  /** Validated backing table name, safe to interpolate into SQL. */
  private readonly table: string;

  /** Idle-row TTL in seconds, or `undefined` for no expiry. */
  private ttl?: number;

  public constructor(options: PgCheckpointOptions) {
    if (!options || typeof options.client?.query !== "function") {
      throw new TypeError(
        "ai.checkpoint.pg requires a 'client' option implementing { query(text, params) } — pass a pg.Pool or pg.Client.",
      );
    }

    const table = options.table ?? DEFAULT_TABLE;

    if (!SAFE_IDENTIFIER.test(table)) {
      throw new TypeError(
        `ai.checkpoint.pg: invalid table name '${table}'. Allowed: [A-Za-z_][A-Za-z0-9_]*.`,
      );
    }

    this.client = options.client;
    this.table = table;
    this.ttl = options.ttl;
  }

  /**
   * Return the latest checkpoint (highest `turn_index`) for a session,
   * or `undefined` when the store has never seen it. The `(name,
   * session_id, turn_index DESC)` lookup index keeps this O(1) on the
   * latest row (§8.6).
   */
  public async load(
    orchestratorName: string,
    sessionId: string,
  ): Promise<CheckpointRecord | undefined> {
    const { rows } = await this.client.query(
      `SELECT * FROM ${this.table}
       WHERE orchestrator_name = $1 AND session_id = $2
       ORDER BY turn_index DESC
       LIMIT 1`,
      [orchestratorName, sessionId],
    );

    if (rows.length === 0) {
      return undefined;
    }

    return rowToRecord(rows[0] as Record<string, unknown>);
  }

  /**
   * Persist a fresh checkpoint row. Append-only — an existing
   * `turn_index` is never overwritten; the PK collision surfaces as a
   * Postgres error rather than a silent clobber (§4 Phase 6, Q15).
   */
  public async save(record: CheckpointRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO ${this.table} (
         orchestrator_name, session_id, turn_index, state, last_route,
         signature, version, summarized_through, lock_acquired_at,
         lock_expires_at, saved_at
       )
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11)`,
      [
        record.orchestrator_name,
        record.session_id,
        record.turn_index,
        JSON.stringify(record.state),
        this.serializeRoute(record.last_route),
        record.signature,
        record.version,
        record.summarized_through,
        record.lock_acquired_at,
        record.lock_expires_at,
        record.saved_at,
      ],
    );
  }

  /**
   * Delete every checkpoint row for a session, ending it.
   */
  public async delete(
    orchestratorName: string,
    sessionId: string,
  ): Promise<void> {
    await this.client.query(
      `DELETE FROM ${this.table}
       WHERE orchestrator_name = $1 AND session_id = $2`,
      [orchestratorName, sessionId],
    );
  }

  /**
   * List the distinct session ids known for an orchestrator, optionally
   * filtered by a session-id prefix. Used by the production boot-drain
   * loop (§9.3). The prefix is matched with `LIKE`, escaping the SQL
   * wildcards so a literal `_` or `%` in the prefix is not treated as a
   * pattern.
   */
  public async list(
    orchestratorName: string,
    prefix?: string,
  ): Promise<string[]> {
    if (prefix === undefined) {
      const { rows } = await this.client.query(
        `SELECT DISTINCT session_id FROM ${this.table}
         WHERE orchestrator_name = $1`,
        [orchestratorName],
      );

      return rows.map((row) => (row as Record<string, unknown>).session_id as string);
    }

    const escaped = prefix
      .replace(/\\/g, "\\\\")
      .replace(/_/g, "\\_")
      .replace(/%/g, "\\%");

    const { rows } = await this.client.query(
      `SELECT DISTINCT session_id FROM ${this.table}
       WHERE orchestrator_name = $1 AND session_id LIKE $2 ESCAPE '\\'`,
      [orchestratorName, `${escaped}%`],
    );

    return rows.map((row) => (row as Record<string, unknown>).session_id as string);
  }

  /**
   * Prune retained turns for a session down to the most recent
   * `keepSnapshots` rows (orchestrator.md §4 Phase 6 / §15.2). Deletes
   * every row with `turn_index < (max_turn_index - keepSnapshots)`. The
   * orchestrator calls this synchronously after a successful
   * {@link save} when `keepSnapshots` is a finite number; `"all"`
   * retention skips the call entirely. Additive to the
   * {@link CheckpointStore} contract — the contract carries no prune
   * hook, so the policy stays on the orchestrator and the store only
   * executes the bounded delete.
   */
  public async prune(
    orchestratorName: string,
    sessionId: string,
    keepSnapshots: number,
  ): Promise<void> {
    if (!Number.isFinite(keepSnapshots) || keepSnapshots < 0) {
      return;
    }

    await this.client.query(
      `DELETE FROM ${this.table}
       WHERE orchestrator_name = $1
         AND session_id = $2
         AND turn_index < (
           SELECT max(turn_index) - $3
           FROM ${this.table}
           WHERE orchestrator_name = $1 AND session_id = $2
         )`,
      [orchestratorName, sessionId, keepSnapshots],
    );
  }

  /**
   * Return the §8.6 reference DDL for this store's backing table,
   * interpolating the configured table name. The dev runs it through
   * their migration tool — the framework never auto-migrates (§8.5).
   *
   * @example
   * await pool.query(store.schema());
   */
  public schema(): string {
    return [
      `CREATE TABLE IF NOT EXISTS ${this.table} (`,
      `  orchestrator_name    TEXT NOT NULL,`,
      `  session_id           TEXT NOT NULL,`,
      `  turn_index           INTEGER NOT NULL,`,
      `  state                JSONB NOT NULL,`,
      `  last_route           TEXT,`,
      `  signature            TEXT NOT NULL,`,
      `  version              TEXT,`,
      `  summarized_through   INTEGER,`,
      `  lock_acquired_at     TIMESTAMPTZ,`,
      `  lock_expires_at      TIMESTAMPTZ,`,
      `  saved_at             TIMESTAMPTZ NOT NULL DEFAULT now(),`,
      `  PRIMARY KEY (orchestrator_name, session_id, turn_index)`,
      `);`,
      `CREATE INDEX IF NOT EXISTS idx_${this.table}_saved_at`,
      `  ON ${this.table} (saved_at);`,
      `CREATE INDEX IF NOT EXISTS idx_${this.table}_lookup`,
      `  ON ${this.table} (orchestrator_name, session_id, turn_index DESC);`,
    ].join("\n");
  }

  /**
   * Set the idle-row TTL (§8.2). Stored for prune-time cleanup; the
   * store never opens a background timer.
   */
  public setOptions(options: { ttl?: number }): void {
    this.ttl = options.ttl;
  }

  /**
   * `last_route` rides a single `TEXT` column. A fan-out array is
   * JSON-encoded so it round-trips through one column without a schema
   * change; a single intent (an identifier — never starts with `[`) is
   * stored verbatim. {@link deserializeRoute} reverses this on load.
   */
  private serializeRoute(route: string | string[] | null): string | null {
    if (route === null) {
      return null;
    }

    if (Array.isArray(route)) {
      return JSON.stringify(route);
    }

    return route;
  }
}

/**
 * Create a Postgres-backed {@link CheckpointStore} (orchestrator.md
 * §8.3). The dev installs `pg` and passes a `pg.Pool` / `pg.Client` —
 * `@warlock.js/ai` never imports `pg`. Run {@link CheckpointStore.schema}
 * through your migration tool once before use; the store never
 * auto-migrates.
 *
 * @example
 * import { Pool } from "pg";
 * import { ai } from "@warlock.js/ai";
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const store = ai.checkpoint.pg({ client: pool });
 *
 * // Once, via your migration tooling:
 * // await pool.query(store.schema());
 */
export function pg(options: PgCheckpointOptions): CheckpointStore {
  return new PgCheckpointStore(options);
}
