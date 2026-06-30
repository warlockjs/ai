import type {
  InterruptStore,
  PendingInterrupt,
  PgClientLike,
} from "../contracts/interrupt-store.contract";

/**
 * Options for the Postgres {@link InterruptStore}.
 *
 * Two mutually-supportive ways to supply the connection:
 * - **`client`** — pass an already-built `pg.Pool` / `pg.Client` (anything
 *   satisfying {@link PgClientLike}). The store only ever calls `query`
 *   and never opens or closes it; a single pool can back both an
 *   orchestrator's checkpoint/snapshot stores and this interrupt table.
 * - **`connectionString`** — let the store lazily `import("pg")` and build
 *   its own `Pool`. `@warlock.js/ai` takes **no** hard dependency on
 *   `pg` (it is an optional peer); when it is absent the store throws a
 *   curated install string at first use, never a raw module-resolution
 *   stack trace at import.
 *
 * Exactly one of the two must be present.
 */
export interface PgInterruptOptions {
  /** An already-built `pg.Pool` / `pg.Client` — anything matching {@link PgClientLike}. */
  client?: PgClientLike;

  /** Connection string the store passes to a lazily-imported `pg.Pool`. */
  connectionString?: string;

  /**
   * Backing table name. Defaults to `warlock_ai_human_interrupts`. Must be
   * a safe SQL identifier — it is interpolated into DDL/DML.
   */
  table?: string;
}

/**
 * Default backing table — provisions the store with no extra config when
 * the dev runs {@link InterruptStore.schema} through their migration tool.
 */
const DEFAULT_TABLE = "warlock_ai_human_interrupts";

/**
 * Allowed characters in a Postgres identifier (table name). The table name
 * is interpolated into DDL/DML, so anything outside this conservative
 * ASCII subset is rejected — interpolating an arbitrary string would be a
 * SQL-injection footgun (mirrors `@warlock.js/ai`'s pg stores).
 */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Module specifier for the optional `pg` driver. Held in a `string`
 * variable so the dynamic `import()` is not statically resolved at
 * compile time — `pg` is an optional peer that need not be installed for
 * this package to type-check or for a memory-only consumer to run.
 */
const PG_MODULE = "pg";

/**
 * Curated install string surfaced (at use time) when a `connectionString`
 * is configured but the optional `pg` driver is absent. Never thrown at
 * import — a memory-only consumer must be able to load this module.
 */
const PG_INSTALL_INSTRUCTIONS = `
The @warlock.js/ai Postgres interrupt store requires the pg package.
Install it with:

  npm install pg

Or with your preferred package manager:

  pnpm add pg
  yarn add pg
`.trim();

/**
 * Minimal structural view of a `pg.Pool` constructor — just enough of the
 * `pg` module surface for the store to build a client when handed a
 * `connectionString`. Declared locally (rather than `typeof import("pg")`)
 * so this module type-checks even when `pg` is not installed.
 */
interface PgModuleLike {
  Pool: new (config: { connectionString: string }) => PgClientLike;
}

/**
 * Lazily import `pg` and return a `Pool` built from `connectionString`. A
 * bare `catch` rethrows the curated install string — a missing optional
 * peer surfaces as actionable guidance, never a raw resolution error.
 */
async function buildPgClient(connectionString: string): Promise<PgClientLike> {
  let sdk: PgModuleLike;

  try {
    sdk = (await import(PG_MODULE)) as unknown as PgModuleLike;
  } catch {
    throw new Error(PG_INSTALL_INSTRUCTIONS);
  }

  return new sdk.Pool({ connectionString });
}

/**
 * Coerce a Postgres timestamp/text column to an ISO string. `pg` returns
 * `TIMESTAMPTZ` as a `Date`; normalize to the ISO wire shape the
 * {@link PendingInterrupt} contract declares.
 */
function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return value as string;
}

/**
 * Map a raw DB row to a {@link PendingInterrupt}. Column names match the
 * reference DDL 1:1; the `request` JSONB rides one column, so it is parsed
 * defensively (node-postgres parses `JSONB` already, but some pool
 * wrappers hand back the raw string).
 */
function rowToRecord(row: Record<string, unknown>): PendingInterrupt {
  const request =
    typeof row.request === "string" ? JSON.parse(row.request) : row.request;

  return {
    interruptId: row.interrupt_id as string,
    request: request as PendingInterrupt["request"],
    status: row.status as PendingInterrupt["status"],
    savedAt: toIso(row.saved_at),
  };
}

/**
 * Postgres-backed {@link InterruptStore} — one durable row per pending
 * interrupt, keyed by `interrupt_id`.
 *
 * Owns: durable round-tripping of the {@link PendingInterrupt} envelope so
 * a reviewer can rule out-of-process (a webhook approves hours later, in a
 * different process), the reference DDL via {@link PgInterruptStore.schema},
 * and prefix-filtered enumeration. Does NOT own: the connection lifecycle
 * (a dev-supplied client is never closed; a store-built `Pool` from a
 * `connectionString` is also left open for the process to reuse) or schema
 * migration (the dev runs `schema()` through their own tool — never
 * auto-migrated).
 *
 * Like the snapshot store, a call has exactly one live interrupt, so
 * `save()` upserts on the `interrupt_id` primary key.
 *
 * Front it with the {@link pg} factory — callers never `new` it.
 */
class PgInterruptStore implements InterruptStore {
  /** Validated backing table name, safe to interpolate into SQL. */
  private readonly table: string;

  /**
   * A ready client, or a promise resolving to one the store builds lazily
   * from a `connectionString`. Resolved once and memoized so the optional
   * `pg` import happens at most once.
   */
  private clientPromise: Promise<PgClientLike>;

  public constructor(options: PgInterruptOptions) {
    const table = options.table ?? DEFAULT_TABLE;

    if (!SAFE_IDENTIFIER.test(table)) {
      throw new TypeError(
        `ai.human.interrupt.pg: invalid table name '${table}'. Allowed: [A-Za-z_][A-Za-z0-9_]*.`,
      );
    }

    this.table = table;

    if (options.client) {
      if (typeof options.client.query !== "function") {
        throw new TypeError(
          "ai.human.interrupt.pg requires a 'client' option implementing { query(text, params) } — pass a pg.Pool or pg.Client.",
        );
      }

      this.clientPromise = Promise.resolve(options.client);

      return;
    }

    if (options.connectionString) {
      // Defer the optional `pg` import to first use — a curated install
      // string surfaces from `buildPgClient`, not at construction.
      this.clientPromise = buildPgClient(options.connectionString);

      return;
    }

    throw new TypeError(
      "ai.human.interrupt.pg requires either a 'client' or a 'connectionString' option.",
    );
  }

  /**
   * Resolve the backing client, surfacing the lazy `pg` import's curated
   * install string on the first call that needs it.
   */
  private client(): Promise<PgClientLike> {
    return this.clientPromise;
  }

  /**
   * Persist a pending interrupt, keyed by its own `interrupt_id`. Upserts
   * — a call has exactly one live interrupt, so a second save for the same
   * id overwrites the payload rather than appending.
   */
  public async save(record: PendingInterrupt): Promise<void> {
    const client = await this.client();

    await client.query(
      `INSERT INTO ${this.table} (interrupt_id, request, status, saved_at)
       VALUES ($1, $2::jsonb, $3, $4)
       ON CONFLICT (interrupt_id) DO UPDATE
         SET request = EXCLUDED.request,
             status = EXCLUDED.status,
             saved_at = EXCLUDED.saved_at`,
      [
        record.interruptId,
        JSON.stringify(record.request),
        record.status,
        record.savedAt,
      ],
    );
  }

  /**
   * Load the interrupt for an `interruptId`, or `undefined` when none is
   * recorded.
   */
  public async load(
    interruptId: string,
  ): Promise<PendingInterrupt | undefined> {
    const client = await this.client();

    const { rows } = await client.query(
      `SELECT interrupt_id, request, status, saved_at
       FROM ${this.table}
       WHERE interrupt_id = $1`,
      [interruptId],
    );

    if (rows.length === 0) {
      return undefined;
    }

    return rowToRecord(rows[0] as Record<string, unknown>);
  }

  /**
   * Drop the interrupt for an `interruptId`. Idempotent — deleting an
   * absent id deletes zero rows.
   */
  public async delete(interruptId: string): Promise<void> {
    const client = await this.client();

    await client.query(
      `DELETE FROM ${this.table} WHERE interrupt_id = $1`,
      [interruptId],
    );
  }

  /**
   * List the interrupt ids known to the store, optionally filtered by a
   * prefix. The `_` and `%` LIKE wildcards in the prefix are escaped so an
   * opaque interruptId that happens to contain them is matched literally.
   */
  public async list(prefix?: string): Promise<string[]> {
    const client = await this.client();

    if (prefix === undefined) {
      const { rows } = await client.query(
        `SELECT interrupt_id FROM ${this.table}`,
      );

      return rows.map(
        (row) => (row as Record<string, unknown>).interrupt_id as string,
      );
    }

    const escaped = prefix
      .replace(/\\/g, "\\\\")
      .replace(/_/g, "\\_")
      .replace(/%/g, "\\%");

    const { rows } = await client.query(
      `SELECT interrupt_id FROM ${this.table}
       WHERE interrupt_id LIKE $1 ESCAPE '\\'`,
      [`${escaped}%`],
    );

    return rows.map(
      (row) => (row as Record<string, unknown>).interrupt_id as string,
    );
  }

  /**
   * Return the reference DDL for this store's backing table, interpolating
   * the configured table name. The dev runs it through their migration
   * tool — the framework never auto-migrates.
   *
   * @example
   * await pool.query(store.schema());
   */
  public schema(): string {
    return [
      `CREATE TABLE IF NOT EXISTS ${this.table} (`,
      `  interrupt_id  TEXT PRIMARY KEY,`,
      `  request       JSONB NOT NULL,`,
      `  status        TEXT NOT NULL,`,
      `  saved_at      TIMESTAMPTZ NOT NULL DEFAULT now()`,
      `);`,
      `CREATE INDEX IF NOT EXISTS idx_${this.table}_saved_at`,
      `  ON ${this.table} (saved_at);`,
    ].join("\n");
  }
}

/**
 * Create a Postgres-backed {@link InterruptStore}. Either pass a live
 * `pg.Pool` / `pg.Client` (`{ client }`) — `@warlock.js/ai` never
 * imports `pg` in that case — or a `{ connectionString }` and let the
 * store lazily `import("pg")` to build its own pool. When `pg` is not
 * installed, the curated install string surfaces on first use, never at
 * import. Run {@link InterruptStore.schema} through your migration tool
 * once before use; the store never auto-migrates.
 *
 * @example
 * import { Pool } from "pg";
 * import { ai } from "@warlock.js/ai";
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const store = ai.human.interrupt.pg({ client: pool });
 *
 * // Once, via your migration tooling:
 * // await pool.query(store.schema());
 *
 * @example
 * // Let the store build its own pool from a connection string:
 * const store = ai.human.interrupt.pg({
 *   connectionString: process.env.DATABASE_URL,
 * });
 */
export function pg(options: PgInterruptOptions): InterruptStore {
  return new PgInterruptStore(options);
}
