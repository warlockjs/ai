import type { VectorStore } from "./vector-store.contract";

/**
 * Minimal `pg`-compatible client surface the Postgres {@link VectorStore}
 * depends on. Both `pg.Pool` and `pg.Client` satisfy it — the store only
 * ever calls `query`.
 *
 * `@warlock.js/ai` takes **no** hard dependency on `pg`; the dev installs
 * it (an optional peer) and passes the client in. Structurally identical
 * to the snapshot / human-interrupt stores' `PgClientLike`, so a single
 * pool can back the orchestrator checkpoint/snapshot tables, the
 * interrupt table, and this vectors table alike.
 */
export interface PgClientLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Options for the Postgres {@link VectorStore}.
 *
 * Two mutually-supportive ways to supply the connection (mirroring
 * `ai.human.interrupt.pg`):
 * - **`client`** — pass an already-built `pg.Pool` / `pg.Client` (anything
 *   satisfying {@link PgClientLike}). The store only ever calls `query`
 *   and never opens or closes it; one pool can back several stores.
 * - **`connectionString`** — let the store lazily `import("pg")` and build
 *   its own `Pool`. `@warlock.js/ai` takes **no** hard dependency on
 *   `pg` (an optional peer); when it is absent the store throws a curated
 *   install string at first use, never a raw module-resolution stack trace
 *   at import.
 *
 * Exactly one of the two must be present.
 */
export interface PgVectorStoreOptions {
  /** An already-built `pg.Pool` / `pg.Client` — anything matching {@link PgClientLike}. */
  client?: PgClientLike;

  /** Connection string the store passes to a lazily-imported `pg.Pool`. */
  connectionString?: string;

  /**
   * Backing table name. Defaults to `warlock_ai_rag_vectors`. Must be a
   * safe SQL identifier — it is interpolated into DDL/DML.
   */
  table?: string;

  /**
   * Embedding dimensionality used in the `CREATE TABLE` DDL emitted by
   * {@link VectorStore.schema | ensureSchema}. Defaults to `1536`
   * (OpenAI `text-embedding-3-small`). The column is declared
   * `vector(N)`; queries and upserts never re-state it, so an existing
   * table provisioned at a different size is unaffected — only the DDL
   * helper reads this.
   */
  dimensions?: number;

  /**
   * Approximate-nearest-neighbour index strategy baked into the DDL
   * emitted by {@link VectorStore.schema | ensureSchema}. Defaults to
   * `"hnsw"` (better recall/latency on modern pgvector). Use `"ivfflat"`
   * for the classic list-partitioned index, or `"none"` to emit no ANN
   * index (exact scan — correct, but linear in row count).
   */
  index?: "hnsw" | "ivfflat" | "none";

  /**
   * `lists` parameter for an `ivfflat` index (ignored for `hnsw` / `none`).
   * Defaults to `100`. Tune toward `rows / 1000` for large tables.
   */
  ivfflatLists?: number;
}

/**
 * Default backing table — provisions the store with no extra config when
 * the dev runs {@link VectorStore.schema | ensureSchema} through their
 * migration tool.
 */
const DEFAULT_TABLE = "warlock_ai_rag_vectors";

/** Default embedding width baked into the DDL (OpenAI `text-embedding-3-small`). */
const DEFAULT_DIMENSIONS = 1536;

/** Default `ivfflat` list count when that index strategy is chosen. */
const DEFAULT_IVFFLAT_LISTS = 100;

/**
 * Allowed characters in a Postgres identifier (table name). The table name
 * is interpolated into DDL/DML, so anything outside this conservative
 * ASCII subset is rejected — interpolating an arbitrary string would be a
 * SQL-injection footgun (mirrors the snapshot / human-interrupt pg stores
 * and `@warlock.js/cache`'s `PgCacheDriver`).
 */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Module specifier for the optional `pg` driver. Held in a `string`
 * variable so the dynamic `import()` is not statically resolved at compile
 * time — `pg` is an optional peer that need not be installed for this
 * package to type-check or for a cache-only consumer to run.
 */
const PG_MODULE = "pg";

/**
 * Curated install string surfaced (at use time) when a `connectionString`
 * is configured but the optional `pg` driver is absent. Never thrown at
 * import — a cache-only consumer must be able to load this module.
 */
const PG_INSTALL_INSTRUCTIONS = `
The @warlock.js/ai Postgres vector store requires the pg package and a
Postgres database with the pgvector extension. Install the driver with:

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
 * Serialize a JS `number[]` to the pgvector text literal: `[1,2,3]`.
 * pgvector accepts a vector either as this bracketed literal or via a
 * typed parameter; passing the literal string + an explicit `::vector`
 * cast keeps the store driver-agnostic (no dependency on a registered
 * `pg` type parser).
 *
 * Non-finite components (`NaN` / `±Infinity`) are rejected — pgvector
 * stores only finite floats, and silently coercing them would corrupt the
 * index. The check is cheap relative to the embed call that produced the
 * vector.
 *
 * @example
 * vectorLiteral([1, 0.5, -2]); // "[1,0.5,-2]"
 */
export function vectorLiteral(vector: number[]): string {
  let literal = "[";

  for (let index = 0; index < vector.length; index++) {
    const component = vector[index];

    if (!Number.isFinite(component)) {
      throw new TypeError(
        `pgVectorStore: embedding component at index ${index} is not finite (${component}); pgvector stores only finite floats.`,
      );
    }

    if (index > 0) {
      literal += ",";
    }

    literal += String(component);
  }

  return literal + "]";
}

/**
 * Coerce a `value` JSONB column back into the stored payload. node-postgres
 * parses `JSONB` into a JS value already, but some pool wrappers hand back
 * the raw string — be defensive across both (mirrors the snapshot store's
 * `parsePayload`).
 */
function parseValue<T>(value: unknown): T {
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }

  return value as T;
}

/**
 * Coerce a pgvector cosine **distance** (`<=>`, in `[0, 2]`, 0 = identical)
 * into the cosine **similarity** score the {@link VectorStore} contract
 * declares (`[0, 1]`, 1 = identical). `pg` returns the computed distance
 * column as a string for `double precision`; parse then map `1 - distance`,
 * clamped to `[0, 1]` so a tiny floating-point overshoot never yields a
 * score just outside the contract's range.
 */
function distanceToScore(distance: unknown): number {
  const value = typeof distance === "string" ? Number(distance) : (distance as number);
  const score = 1 - value;

  if (score < 0) {
    return 0;
  }

  if (score > 1) {
    return 1;
  }

  return score;
}

/**
 * Postgres + pgvector-backed {@link VectorStore} — one durable row per
 * indexed chunk, keyed by the RAG pipeline's dotted `key`
 * (`ai.rag.<name>.<sourceId>.<chunkIndex>`), with the chunk payload in a
 * `value` JSONB column and the embedding in a `vector` column.
 *
 * Owns: the three RAG vector operations against a pgvector index —
 * `upsert` (INSERT … ON CONFLICT DO UPDATE), `query` (cosine
 * `ORDER BY embedding <=> $vec` with a `threshold` floor + optional `tags`
 * overlap filter, capped at `topK`), and `removeNamespace` (prefix DELETE).
 * Also emits the reference DDL via {@link PgVectorStore.schema} (alias
 * {@link PgVectorStore.ensureSchema}).
 *
 * Does NOT own: the connection lifecycle (a dev-supplied `client` is never
 * closed; a store-built `Pool` from a `connectionString` is also left open
 * for the process to reuse) or schema migration — the dev runs the DDL
 * through their own tool; the framework never auto-migrates.
 *
 * Front it with the {@link pgVectorStore} factory — callers never `new` it.
 */
class PgVectorStore implements VectorStore {
  /** Validated backing table name, safe to interpolate into SQL. */
  private readonly table: string;

  /** Embedding width baked into the DDL. */
  private readonly dimensions: number;

  /** ANN index strategy baked into the DDL. */
  private readonly index: "hnsw" | "ivfflat" | "none";

  /** `lists` parameter for an `ivfflat` index. */
  private readonly ivfflatLists: number;

  /**
   * A ready client, or a promise resolving to one the store builds lazily
   * from a `connectionString`. Resolved once and memoized so the optional
   * `pg` import happens at most once.
   */
  private readonly clientPromise: Promise<PgClientLike>;

  public constructor(options: PgVectorStoreOptions) {
    const table = options.table ?? DEFAULT_TABLE;

    if (!SAFE_IDENTIFIER.test(table)) {
      throw new TypeError(
        `pgVectorStore: invalid table name '${table}'. Allowed: [A-Za-z_][A-Za-z0-9_]*.`,
      );
    }

    this.table = table;
    this.dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
    this.index = options.index ?? "hnsw";
    this.ivfflatLists = options.ivfflatLists ?? DEFAULT_IVFFLAT_LISTS;

    if (options.client) {
      if (typeof options.client.query !== "function") {
        throw new TypeError(
          "pgVectorStore requires a 'client' option implementing { query(text, params) } — pass a pg.Pool or pg.Client.",
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
      "pgVectorStore requires either a 'client' or a 'connectionString' option.",
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
   * Index `value` under `key` with its embedding `vector`. Upserts on the
   * `key` primary key — re-indexing the same chunk overwrites its payload,
   * embedding, and tags rather than appending a duplicate row. Optional
   * `tags` ride a `text[]` column so {@link query} can restrict the
   * candidate set with an array-overlap filter.
   *
   * The embedding is sent as a pgvector text literal (`$3`) cast to
   * `::vector`, so the store needs no registered `pg` type parser. `tags`
   * defaults to an empty array (never `NULL`) to keep the overlap filter's
   * `&&` semantics simple.
   */
  public async upsert(
    key: string,
    value: unknown,
    vector: number[],
    tags?: string[],
  ): Promise<void> {
    const client = await this.client();

    await client.query(
      `INSERT INTO ${this.table} (key, value, embedding, tags)
       VALUES ($1, $2::jsonb, $3::vector, $4::text[])
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value,
             embedding = EXCLUDED.embedding,
             tags = EXCLUDED.tags`,
      [key, JSON.stringify(value), vectorLiteral(vector), tags ?? []],
    );
  }

  /**
   * Return the cosine-nearest rows to `vector`, mapped to the contract's
   * `{ key, value, score }` shape. The SQL:
   *
   * - computes `embedding <=> $1::vector` (cosine **distance**) once, aliased
   *   `distance`, and `ORDER BY` it ascending (nearest first);
   * - applies the `threshold` floor as `distance <= 1 - threshold`
   *   (similarity `>=` threshold), so the default `0.5` floor maps to a
   *   `<= 0.5` distance bound — the filter runs in SQL, not in JS, so a
   *   below-floor row never crosses the wire;
   * - when `tags` are given, restricts to rows whose `tags` array overlaps
   *   the requested set via `tags && $tags::text[]` (one-of semantics,
   *   matching the cache store);
   * - caps the result at `topK` with `LIMIT`.
   *
   * The returned `score` is `1 - distance`, clamped to `[0, 1]`, so callers
   * see the same cosine-similarity scale the cache store emits.
   */
  public async query<T>(
    vector: number[],
    options: { topK: number; threshold?: number; tags?: string[] },
  ): Promise<{ key: string; value: T; score: number }[]> {
    const client = await this.client();
    const queryVector = vectorLiteral(vector);

    // $1 = query vector, $2 = topK. Optional threshold + tags are appended
    // as $3 / $4 only when present, so the prepared statement carries no
    // unused placeholders.
    const params: unknown[] = [queryVector, options.topK];
    const conditions: string[] = [];

    if (options.threshold !== undefined) {
      params.push(1 - options.threshold);
      conditions.push(`(embedding <=> $1::vector) <= $${params.length}`);
    }

    if (options.tags !== undefined && options.tags.length > 0) {
      params.push(options.tags);
      conditions.push(`tags && $${params.length}::text[]`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows } = await client.query(
      `SELECT key, value, (embedding <=> $1::vector) AS distance
       FROM ${this.table}
       ${where}
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      params,
    );

    return (rows as Record<string, unknown>[]).map((row) => ({
      key: row.key as string,
      value: parseValue<T>(row.value),
      score: distanceToScore(row.distance),
    }));
  }

  /**
   * Drop every entry written under `namespace`. The RAG pipeline keys
   * chunks as `<namespace>.<sourceId>.<chunkIndex>`, so a row belongs to
   * the namespace when its `key` equals it OR begins with `<namespace>.`
   * — deleting `ai.rag.docs` must not also catch `ai.rag.docs2`. The `_`
   * and `%` LIKE wildcards in the namespace are escaped so a namespace
   * that happens to contain them is matched literally.
   */
  public async removeNamespace(namespace: string): Promise<void> {
    const client = await this.client();

    const escaped = namespace
      .replace(/\\/g, "\\\\")
      .replace(/_/g, "\\_")
      .replace(/%/g, "\\%");

    await client.query(
      `DELETE FROM ${this.table}
       WHERE key = $1 OR key LIKE $2 ESCAPE '\\'`,
      [namespace, `${escaped}.%`],
    );
  }

  /**
   * Return the reference migration DDL for this store's backing table,
   * interpolating the configured table name, embedding width, and ANN
   * index strategy. The dev runs it once through their migration tool —
   * the framework never auto-migrates.
   *
   * The emitted statements:
   * 1. `CREATE EXTENSION IF NOT EXISTS vector;` — enables pgvector (needs
   *    a superuser or a role with `CREATE` on the database the first time).
   * 2. `CREATE TABLE IF NOT EXISTS <table> (key TEXT PRIMARY KEY, value
   *    JSONB NOT NULL, embedding vector(<dimensions>) NOT NULL, tags
   *    text[] NOT NULL DEFAULT '{}');`
   * 3. A GIN index on `tags` so the array-overlap filter stays sargable.
   * 4. The chosen ANN index over `embedding` using `vector_cosine_ops`:
   *    - `"hnsw"` → `USING hnsw (embedding vector_cosine_ops)`;
   *    - `"ivfflat"` → `USING ivfflat (embedding vector_cosine_ops)
   *      WITH (lists = <ivfflatLists>)`;
   *    - `"none"` → emitted as a comment (exact scan, no ANN index).
   *
   * @example
   * const store = pgVectorStore({ client: pool, dimensions: 1536 });
   * await pool.query(store.ensureSchema());
   */
  public schema(): string {
    const lines = [
      `CREATE EXTENSION IF NOT EXISTS vector;`,
      `CREATE TABLE IF NOT EXISTS ${this.table} (`,
      `  key        TEXT PRIMARY KEY,`,
      `  value      JSONB NOT NULL,`,
      `  embedding  vector(${this.dimensions}) NOT NULL,`,
      `  tags       TEXT[] NOT NULL DEFAULT '{}'`,
      `);`,
      `CREATE INDEX IF NOT EXISTS idx_${this.table}_tags`,
      `  ON ${this.table} USING gin (tags);`,
    ];

    if (this.index === "hnsw") {
      lines.push(
        `CREATE INDEX IF NOT EXISTS idx_${this.table}_embedding`,
        `  ON ${this.table} USING hnsw (embedding vector_cosine_ops);`,
      );
    } else if (this.index === "ivfflat") {
      lines.push(
        `CREATE INDEX IF NOT EXISTS idx_${this.table}_embedding`,
        `  ON ${this.table} USING ivfflat (embedding vector_cosine_ops)`,
        `  WITH (lists = ${this.ivfflatLists});`,
      );
    } else {
      lines.push(
        `-- No ANN index requested (index: "none"): cosine queries fall back`,
        `-- to an exact sequential scan, which is correct but linear in rows.`,
      );
    }

    return lines.join("\n");
  }

  /**
   * Alias for {@link PgVectorStore.schema} — reads more naturally in a
   * migration script (`await pool.query(store.ensureSchema())`). Returns
   * the identical DDL string; it does NOT execute anything against the
   * database (the store never auto-migrates).
   */
  public ensureSchema(): string {
    return this.schema();
  }
}

/**
 * The {@link VectorStore} surface plus the pg store's extra DDL helpers.
 * `schema()` / `ensureSchema()` are not part of the base contract (the
 * cache store has no backing table), so the factory's return type widens
 * it for callers that want the migration SQL.
 */
export interface PgVectorStoreInstance extends VectorStore {
  /** Reference migration DDL (extension + table + indexes). Never executed. */
  schema(): string;
  /** Alias for {@link PgVectorStoreInstance.schema} — reads better in a migration script. */
  ensureSchema(): string;
}

/**
 * Create a Postgres + pgvector-backed {@link VectorStore} for the RAG
 * pipeline. Either pass a live `pg.Pool` / `pg.Client` (`{ client }`) —
 * `@warlock.js/ai` never imports `pg` in that case — or a
 * `{ connectionString }` and let the store lazily `import("pg")` to build
 * its own pool. When `pg` is not installed, a curated install string
 * surfaces on first use, never at import.
 *
 * Run {@link PgVectorStoreInstance.ensureSchema} through your migration
 * tool once before use (it enables the `vector` extension, creates the
 * table, and builds the tag + ANN indexes); the store never auto-migrates.
 *
 * Index and query MUST use the same embedding model — the `vector(N)`
 * column width is fixed at table-creation time from `dimensions`.
 *
 * @example
 * import { Pool } from "pg";
 * import { ai } from "@warlock.js/ai";
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const store = ai.rag.pgVectorStore({ client: pool, dimensions: 1536 });
 *
 * // Once, via your migration tooling:
 * // await pool.query(store.ensureSchema());
 *
 * const kb = ai.rag({
 *   name: "docs",
 *   embedder: openai.embedder({ name: "text-embedding-3-small" }),
 *   store,
 * });
 *
 * @example
 * // Let the store build its own pool from a connection string:
 * const store = ai.rag.pgVectorStore({
 *   connectionString: process.env.DATABASE_URL,
 *   index: "ivfflat",
 *   ivfflatLists: 200,
 * });
 */
export function pgVectorStore(options: PgVectorStoreOptions): PgVectorStoreInstance {
  return new PgVectorStore(options);
}
