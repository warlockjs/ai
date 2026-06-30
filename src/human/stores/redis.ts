import type {
  InterruptStore,
  PendingInterrupt,
  RedisClientLike,
} from "../contracts/interrupt-store.contract";

/**
 * Options for the Redis {@link InterruptStore}.
 *
 * Two mutually-supportive ways to supply the connection:
 * - **`client`** — pass an already-connected `redis` client (anything
 *   satisfying {@link RedisClientLike}). The store only calls
 *   `get` / `set` / `del` and never connects or quits it.
 * - **`url`** — let the store lazily `import("redis")`, build a client
 *   from the url, and connect it. `@warlock.js/ai` takes **no** hard
 *   dependency on `redis` (it is an optional peer); when it is absent the
 *   store throws a curated install string at first use, never a raw
 *   module-resolution stack trace at import.
 *
 * Exactly one of the two must be present.
 */
export interface RedisInterruptOptions {
  /** An already-connected `redis` client — anything matching {@link RedisClientLike}. */
  client?: RedisClientLike;

  /** Connection url the store passes to a lazily-imported `createClient`. */
  url?: string;

  /**
   * Key prefix prepended to every key this store writes. Lets one Redis
   * database back multiple stores without collision. Defaults to
   * `warlock:ai-human:interrupt:`.
   */
  prefix?: string;
}

/**
 * Default key prefix — namespaces the store's keys inside a shared Redis
 * database so interrupt records coexist with other data without collision.
 */
const DEFAULT_PREFIX = "warlock:ai-human:interrupt:";

/**
 * Index key (under the configured prefix) holding the JSON array of live
 * interrupt ids. The structural {@link RedisClientLike} surface exposes no
 * `SCAN` / `KEYS`, so enumeration for `list()` is self-maintained.
 */
const INDEX_SUFFIX = "index";

/**
 * Module specifier for the optional `redis` driver. Held in a `string`
 * variable so the dynamic `import()` is not statically resolved at compile
 * time — `redis` is an optional peer that need not be installed for this
 * package to type-check or for a memory-only consumer to run.
 */
const REDIS_MODULE = "redis";

/**
 * Curated install string surfaced (at use time) when a `url` is configured
 * but the optional `redis` driver is absent. Never thrown at import — a
 * memory-only consumer must be able to load this module.
 */
const REDIS_INSTALL_INSTRUCTIONS = `
The @warlock.js/ai Redis interrupt store requires the redis package.
Install it with:

  npm install redis

Or with your preferred package manager:

  pnpm add redis
  yarn add redis
`.trim();

/**
 * Minimal structural view of the `redis` module surface — just enough to
 * build and connect a client from a url. Declared locally (rather than
 * `typeof import("redis")`) so this module type-checks even when `redis`
 * is not installed.
 */
interface RedisModuleLike {
  createClient(config: {
    url: string;
  }): RedisClientLike & { connect(): Promise<unknown> };
}

/**
 * Lazily import `redis`, build a client from `url`, and connect it. A bare
 * `catch` rethrows the curated install string — a missing optional peer
 * surfaces as actionable guidance, never a raw resolution error.
 */
async function buildRedisClient(url: string): Promise<RedisClientLike> {
  let sdk: RedisModuleLike;

  try {
    sdk = (await import(REDIS_MODULE)) as unknown as RedisModuleLike;
  } catch {
    throw new Error(REDIS_INSTALL_INSTRUCTIONS);
  }

  const client = sdk.createClient({ url });
  await client.connect();

  return client;
}

/**
 * Redis-backed {@link InterruptStore} — one JSON string value per pending
 * interrupt, under a namespaced key, plus a self-maintained id index so
 * `list()` works without `SCAN`/`KEYS`.
 *
 * Owns: durable round-tripping of the {@link PendingInterrupt} envelope so
 * a reviewer can rule out-of-process, the namespaced key layout, and the
 * per-store id index that backs enumeration. Does NOT own: durability
 * guarantees beyond Redis's own, the connection lifecycle (a dev-supplied
 * client is never disconnected; a store-built client from a `url` is left
 * connected for the process to reuse), or migration —
 * {@link RedisInterruptStore.schema} returns an empty string.
 *
 * A call has exactly one live interrupt, so `save()` overwrites the key.
 *
 * Front it with the {@link redis} factory — callers never `new` it.
 */
class RedisInterruptStore implements InterruptStore {
  /** Key prefix namespacing every key this store writes. */
  private readonly prefix: string;

  /**
   * A ready client, or a promise resolving to one the store builds lazily
   * from a `url`. Resolved once and memoized so the optional `redis`
   * import + connect happens at most once.
   */
  private clientPromise: Promise<RedisClientLike>;

  public constructor(options: RedisInterruptOptions) {
    this.prefix = options.prefix ?? DEFAULT_PREFIX;

    if (options.client) {
      if (
        typeof options.client.get !== "function" ||
        typeof options.client.set !== "function" ||
        typeof options.client.del !== "function"
      ) {
        throw new TypeError(
          "ai.human.interrupt.redis requires a 'client' option implementing { get, set, del } — pass a connected redis client.",
        );
      }

      this.clientPromise = Promise.resolve(options.client);

      return;
    }

    if (options.url) {
      // Defer the optional `redis` import to first use — a curated install
      // string surfaces from `buildRedisClient`, not at construction.
      this.clientPromise = buildRedisClient(options.url);

      return;
    }

    throw new TypeError(
      "ai.human.interrupt.redis requires either a 'client' or a 'url' option.",
    );
  }

  /**
   * Resolve the backing client, surfacing the lazy `redis` import's
   * curated install string on the first call that needs it.
   */
  private client(): Promise<RedisClientLike> {
    return this.clientPromise;
  }

  /**
   * Persist a pending interrupt, keyed by its own `interruptId`, and index
   * the id for enumeration. Overwrites any prior record for the same id —
   * a call has exactly one live interrupt.
   */
  public async save(record: PendingInterrupt): Promise<void> {
    const client = await this.client();

    await client.set(this.recordKey(record.interruptId), JSON.stringify(record));
    await this.indexId(record.interruptId);
  }

  /**
   * Load the interrupt for an `interruptId`, or `undefined` when the key is
   * missing. Redis returns `null` for an absent key — converted to
   * `undefined` at the boundary.
   */
  public async load(
    interruptId: string,
  ): Promise<PendingInterrupt | undefined> {
    const client = await this.client();
    const raw = await client.get(this.recordKey(interruptId));

    if (raw === null) {
      return undefined;
    }

    return JSON.parse(raw) as PendingInterrupt;
  }

  /**
   * Drop the interrupt for an `interruptId` and de-index its id. Idempotent
   * — deleting an absent id is a no-op.
   */
  public async delete(interruptId: string): Promise<void> {
    const client = await this.client();

    await client.del(this.recordKey(interruptId));
    await this.deindexId(interruptId);
  }

  /**
   * List the interrupt ids known to the store, optionally filtered by a
   * prefix. Reads the self-maintained index document.
   */
  public async list(prefix?: string): Promise<string[]> {
    const ids = await this.readIndex();

    if (prefix === undefined) {
      return ids;
    }

    return ids.filter((id) => id.startsWith(prefix));
  }

  /**
   * Redis needs no relational table — there is nothing to migrate. Returns
   * an empty string so callers can treat `schema()` uniformly across
   * drivers.
   */
  public schema(): string {
    return "";
  }

  /**
   * Read and parse the id index, defaulting to an empty list when absent.
   */
  private async readIndex(): Promise<string[]> {
    const client = await this.client();
    const raw = await client.get(this.indexKey());

    if (raw === null) {
      return [];
    }

    return JSON.parse(raw) as string[];
  }

  /**
   * Add an interrupt id to the index, no-op when already present.
   */
  private async indexId(interruptId: string): Promise<void> {
    const ids = await this.readIndex();

    if (ids.includes(interruptId)) {
      return;
    }

    ids.push(interruptId);

    const client = await this.client();
    await client.set(this.indexKey(), JSON.stringify(ids));
  }

  /**
   * Remove an interrupt id from the index, no-op when absent.
   */
  private async deindexId(interruptId: string): Promise<void> {
    const ids = await this.readIndex();
    const next = ids.filter((id) => id !== interruptId);

    if (next.length === ids.length) {
      return;
    }

    const client = await this.client();
    await client.set(this.indexKey(), JSON.stringify(next));
  }

  /**
   * Key for a single interrupt record — `<prefix><interruptId>`.
   */
  private recordKey(interruptId: string): string {
    return `${this.prefix}${interruptId}`;
  }

  /**
   * Key for the self-maintained id index — `<prefix>index`.
   */
  private indexKey(): string {
    return `${this.prefix}${INDEX_SUFFIX}`;
  }
}

/**
 * Create a Redis-backed {@link InterruptStore}. Either pass a connected
 * `redis` client (`{ client }`) — `@warlock.js/ai` never imports
 * `redis` in that case — or a `{ url }` and let the store lazily
 * `import("redis")`, build, and connect a client. When `redis` is not
 * installed, the curated install string surfaces on first use, never at
 * import. {@link InterruptStore.schema} returns an empty string; Redis
 * needs no migration.
 *
 * @example
 * import { createClient } from "redis";
 * import { ai } from "@warlock.js/ai";
 *
 * const client = createClient({ url: process.env.REDIS_URL });
 * await client.connect();
 *
 * const store = ai.human.interrupt.redis({ client });
 *
 * @example
 * // Let the store build + connect its own client from a url:
 * const store = ai.human.interrupt.redis({ url: process.env.REDIS_URL });
 */
export function redis(options: RedisInterruptOptions): InterruptStore {
  return new RedisInterruptStore(options);
}
