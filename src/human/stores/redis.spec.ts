import { describe, expect, it, vi } from "vitest";
import type {
  PendingInterrupt,
  RedisClientLike,
} from "../contracts/interrupt-store.contract";
import { redis } from "./redis";

// Simulate `redis` NOT being installed: a dynamic `import("redis")`
// rejects, so the store's lazy loader must surface the curated install
// string — never a raw resolution error. Scoped to this file; the
// round-trip tests below use a passed-in `{ client }` and never trigger
// the dynamic import, so the mock leaves them untouched.
vi.mock("redis", () => {
  throw new Error("Cannot find module 'redis'");
});

/**
 * A minimal in-memory fake of a `redis` client satisfying
 * {@link RedisClientLike} — a `Map` behind `get`/`set`/`del`, returning
 * `null` for a missing key the way the real client does. Exposes the
 * backing store so tests can assert on the namespaced keys.
 */
function makeFakeRedis(): RedisClientLike & { store: Map<string, string> } {
  const store = new Map<string, string>();

  return {
    store,
    async get(key: string): Promise<string | null> {
      return store.has(key) ? store.get(key)! : null;
    },
    async set(key: string, value: string): Promise<unknown> {
      store.set(key, value);

      return "OK";
    },
    async del(key: string): Promise<number> {
      return store.delete(key) ? 1 : 0;
    },
  };
}

function makeInterrupt(
  overrides: Partial<PendingInterrupt> = {},
): PendingInterrupt {
  return {
    interruptId: "support.sess-1.0.abc",
    request: {
      interruptId: "support.sess-1.0.abc",
      toolName: "refundCustomer",
      args: { orderId: "4821", amount: 50 },
      context: { agentName: "support", tripIndex: 0, sessionId: "sess-1" },
      requestedAt: new Date().toISOString(),
    },
    status: "pending",
    savedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("redis interrupt store", () => {
  it("should throw when neither client nor url is given", () => {
    expect(() => redis({})).toThrow(/'client' or a 'url'/);
  });

  it("should reject a client missing required methods", () => {
    expect(() =>
      redis({
        client: { get: async () => null } as unknown as RedisClientLike,
      }),
    ).toThrow(/requires a 'client'/);
  });

  it("should return undefined for an unknown interrupt id", async () => {
    const store = redis({ client: makeFakeRedis() });

    expect(await store.load("missing")).toBeUndefined();
  });

  it("should round-trip a saved interrupt", async () => {
    const store = redis({ client: makeFakeRedis() });
    const record = makeInterrupt();

    await store.save(record);
    const loaded = await store.load(record.interruptId);

    expect(loaded).toEqual(record);
  });

  it("should overwrite the record for the same id", async () => {
    const client = makeFakeRedis();
    const store = redis({ client });

    await store.save(makeInterrupt({ status: "pending" }));
    await store.save(makeInterrupt({ status: "resolved" }));

    expect((await store.load("support.sess-1.0.abc"))?.status).toBe(
      "resolved",
    );
  });

  it("should namespace keys under the default prefix", async () => {
    const client = makeFakeRedis();
    const store = redis({ client });

    await store.save(makeInterrupt({ interruptId: "abc" }));

    expect(client.store.has("warlock:ai-human:interrupt:abc")).toBe(true);
  });

  it("should honor a custom key prefix", async () => {
    const client = makeFakeRedis();
    const store = redis({ client, prefix: "app:hitl:" });

    await store.save(makeInterrupt({ interruptId: "r1" }));

    expect(client.store.has("app:hitl:r1")).toBe(true);
    expect(await store.load("r1")).toBeDefined();
  });

  it("should delete a record and de-index its id", async () => {
    const store = redis({ client: makeFakeRedis() });

    await store.save(makeInterrupt({ interruptId: "a" }));
    await store.delete("a");

    expect(await store.load("a")).toBeUndefined();
    expect(await store.list?.()).toEqual([]);
  });

  it("should treat deleting an absent id as a no-op", async () => {
    const store = redis({ client: makeFakeRedis() });

    await expect(store.delete("ghost")).resolves.toBeUndefined();
  });

  it("should list every known interrupt id via the self-maintained index", async () => {
    const store = redis({ client: makeFakeRedis() });

    await store.save(makeInterrupt({ interruptId: "a" }));
    await store.save(makeInterrupt({ interruptId: "b" }));

    expect((await store.list?.())?.sort()).toEqual(["a", "b"]);
  });

  it("should filter listed ids by prefix", async () => {
    const store = redis({ client: makeFakeRedis() });

    await store.save(makeInterrupt({ interruptId: "support.1" }));
    await store.save(makeInterrupt({ interruptId: "support.2" }));
    await store.save(makeInterrupt({ interruptId: "billing.1" }));

    expect((await store.list?.("support."))?.sort()).toEqual([
      "support.1",
      "support.2",
    ]);
  });

  it("should not double-index a re-saved id", async () => {
    const store = redis({ client: makeFakeRedis() });

    await store.save(makeInterrupt({ interruptId: "a" }));
    await store.save(makeInterrupt({ interruptId: "a", status: "resolved" }));

    expect(await store.list?.()).toEqual(["a"]);
  });

  it("should expose an empty schema for the redis store", () => {
    const store = redis({ client: makeFakeRedis() });

    expect(store.schema()).toBe("");
  });

  it("should surface the curated install string when redis is absent", async () => {
    // No `client` — the store lazily `import("redis")`, which the mock
    // above makes reject; the loader rethrows the curated install string
    // on the first operation that needs the client.
    const store = redis({ url: "redis://localhost:6379" });

    await expect(store.save(makeInterrupt())).rejects.toThrow(
      /requires the redis package/,
    );
  });
});
