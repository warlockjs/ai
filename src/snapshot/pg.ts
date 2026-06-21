import type {
  PgClientLike,
  SnapshotStore,
} from "../contracts/orchestrator/snapshot-store.contract";
import type { SupervisorSnapshot } from "../contracts/supervisor/supervisor-snapshot.type";

/**
 * Default backing table for the pg snapshot store. Matches the name used
 * in the orchestrator.md §8 reference wiring
 * (`ai.snapshot.pg({ client, table: "warlock_supervisor_snapshots" })`).
 */
const DEFAULT_TABLE = "warlock_supervisor_snapshots";

/**
 * Allowed characters in a Postgres identifier (table name). The
 * conservative ASCII subset; anything else is rejected because the table
 * name is interpolated directly into DDL/DML, and an arbitrary string
 * there would be a SQL-injection footgun. Mirrors `@warlock.js/cache`'s
 * `PgCacheDriver`.
 */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Options for {@link pg}. The `client` is an already-built `pg.Pool` /
 * `pg.Client` (anything satisfying {@link PgClientLike}); the store never
 * opens or closes it — connection lifecycle stays with the caller.
 */
export type PgSnapshotStoreOptions = {
  /** Pre-built pg client. The store only ever calls `query`. */
  client: PgClientLike;
  /** Table name. Defaults to `warlock_supervisor_snapshots`. */
  table?: string;
};

/**
 * Validate and resolve the table name. Throws on an unsafe identifier so
 * the failure surfaces at construction time, not on the first query.
 */
function resolveTable(table: string | undefined): string {
  const resolved = table ?? DEFAULT_TABLE;

  if (!SAFE_IDENTIFIER.test(resolved)) {
    throw new Error(
      `Pg snapshot store: invalid table name '${resolved}'. Allowed: [A-Za-z_][A-Za-z0-9_]*.`,
    );
  }

  return resolved;
}

/**
 * Coerce a `payload` column value back into a {@link SupervisorSnapshot}.
 * node-postgres parses `JSONB` into a JS value already, but some pool
 * wrappers hand back the raw string — be defensive across both.
 */
function parsePayload(payload: unknown): SupervisorSnapshot {
  if (typeof payload === "string") {
    return JSON.parse(payload) as SupervisorSnapshot;
  }

  return payload as SupervisorSnapshot;
}

/**
 * Postgres {@link SnapshotStore} — supervisor run snapshots persisted to a
 * single row per `runId` in a dev-provisioned table (orchestrator.md §8).
 *
 * Owns: durable round-tripping of the {@link SupervisorSnapshot} envelope
 * keyed by `runId`, so a crashed mid-turn `iterate: true` iteration can
 * resume after a restart. Does NOT own: the connection (the caller passes
 * a live `pg.Pool`/`pg.Client` and keeps owning its lifecycle) or schema
 * migration ({@link PgSnapshotStore.schema} returns DDL the dev runs
 * themselves — the framework never auto-migrates, §8.5).
 *
 * Unlike the append-only checkpoint store, a run has exactly one live
 * snapshot, so `save()` upserts on the `run_id` primary key.
 *
 * Front it with the {@link pg} factory — callers never `new` it.
 */
class PgSnapshotStore implements SnapshotStore {
  /** The user-supplied pg client. The store only ever calls `query`. */
  private readonly client: PgClientLike;

  /** Validated, resolved table name. Safe to interpolate into SQL. */
  private readonly table: string;

  public constructor(options: PgSnapshotStoreOptions) {
    if (!options || !options.client || typeof options.client.query !== "function") {
      throw new Error(
        "Pg snapshot store requires a 'client' option implementing { query(text, params) } — pass a pg.Pool or pg.Client.",
      );
    }

    this.client = options.client;
    this.table = resolveTable(options.table);
  }

  /**
   * Load the snapshot for a `runId`, or `undefined` when no in-flight run
   * is recorded.
   */
  public async load(runId: string): Promise<SupervisorSnapshot | undefined> {
    const { rows } = await this.client.query(
      `SELECT payload FROM ${this.table} WHERE run_id = $1`,
      [runId],
    );

    if (rows.length === 0) {
      return undefined;
    }

    return parsePayload((rows[0] as { payload: unknown }).payload);
  }

  /**
   * Persist a snapshot, keyed by its own `runId`. Upserts — a run has
   * exactly one live snapshot, so a second save for the same `runId`
   * overwrites the payload rather than appending.
   */
  public async save(snapshot: SupervisorSnapshot): Promise<void> {
    await this.client.query(
      `INSERT INTO ${this.table} (run_id, payload, saved_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (run_id) DO UPDATE
         SET payload = EXCLUDED.payload,
             saved_at = EXCLUDED.saved_at`,
      [snapshot.runId, JSON.stringify(snapshot)],
    );
  }

  /**
   * Drop the snapshot for a `runId`.
   */
  public async delete(runId: string): Promise<void> {
    await this.client.query(`DELETE FROM ${this.table} WHERE run_id = $1`, [
      runId,
    ]);
  }

  /**
   * List the known run ids, optionally filtered by a prefix. The `_` and
   * `%` LIKE wildcards in the prefix are escaped so an opaque runId that
   * happens to contain them is matched literally.
   */
  public async list(prefix?: string): Promise<string[]> {
    if (prefix === undefined) {
      const { rows } = await this.client.query(
        `SELECT run_id FROM ${this.table}`,
      );

      return rows.map((row) => (row as { run_id: string }).run_id);
    }

    const escaped = prefix
      .replace(/\\/g, "\\\\")
      .replace(/_/g, "\\_")
      .replace(/%/g, "\\%");

    const { rows } = await this.client.query(
      `SELECT run_id FROM ${this.table} WHERE run_id LIKE $1 ESCAPE '\\'`,
      [`${escaped}%`],
    );

    return rows.map((row) => (row as { run_id: string }).run_id);
  }

  /**
   * Return the DDL for this store's backing table. Run once via the
   * caller's migration tooling — the store never auto-migrates (§8.5).
   *
   * @example
   * await pool.query(store.schema());
   */
  public schema(): string {
    return [
      `CREATE TABLE IF NOT EXISTS ${this.table} (`,
      `  run_id    TEXT PRIMARY KEY,`,
      `  payload   JSONB NOT NULL,`,
      `  saved_at  TIMESTAMPTZ NOT NULL DEFAULT now()`,
      `);`,
      `CREATE INDEX IF NOT EXISTS idx_${this.table}_saved_at ON ${this.table} (saved_at);`,
    ].join("\n");
  }
}

/**
 * Create a Postgres-backed {@link SnapshotStore}. Pass a live
 * `pg.Pool`/`pg.Client` — the store never opens or closes it. Schema is
 * not auto-migrated: run {@link SnapshotStore.schema} through your own
 * migration tool first.
 *
 * @example
 * import { Pool } from "pg";
 * import { ai } from "@warlock.js/ai";
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 *
 * const orchestrator = ai.orchestrator({
 *   name: "support",
 *   intents: { ... },
 *   iterate: true,
 *   snapshotStore: ai.snapshot.pg({
 *     client: pool,
 *     table: "warlock_supervisor_snapshots",
 *   }),
 * });
 *
 * // Run once, via your own migration tooling:
 * // await pool.query(orchestrator's store.schema());
 */
export function pg(options: PgSnapshotStoreOptions): SnapshotStore {
  return new PgSnapshotStore(options);
}
