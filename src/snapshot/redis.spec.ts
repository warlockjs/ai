import { describe, expect, it } from "vitest";
import type { RedisClientLike } from "../contracts/orchestrator/snapshot-store.contract";
import type { SupervisorSnapshot } from "../contracts/supervisor/supervisor-snapshot.type";
import { redis } from "./redis";

function makeSnapshot(
  overrides: Partial<SupervisorSnapshot> = {},
): SupervisorSnapshot {
  return {
    runId: "sess-1.unversioned.0",
    supervisorName: "support",
    signature: "sig-abc",
    input: "hello",
    iteration: 0,
    snapshots: [],
    status: "running",
    startedAt: new Date().toISOString(),
    savedAt: new Date().toISOString(),
    ...overrides,
  };
}

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
      const existed = store.delete(key);

      return existed ? 1 : 0;
    },
  };
}

describe("snapshot redis store", () => {
  it("should return undefined for an unknown runId", async () => {
    const client = makeFakeRedis();
    const store = redis({ client });

    const loaded = await store.load("missing");

    expect(loaded).toBeUndefined();
  });

  it("should round-trip a saved snapshot", async () => {
    const client = makeFakeRedis();
    const store = redis({ client });
    const snapshot = makeSnapshot({ iteration: 3 });

    await store.save(snapshot);
    const loaded = await store.load("sess-1.unversioned.0");

    expect(loaded).toEqual(snapshot);
  });

  it("should overwrite the snapshot for the same runId", async () => {
    const client = makeFakeRedis();
    const store = redis({ client });

    await store.save(makeSnapshot({ iteration: 0, status: "running" }));
    await store.save(makeSnapshot({ iteration: 1, status: "completed" }));

    const loaded = await store.load("sess-1.unversioned.0");

    expect(loaded?.iteration).toBe(1);
    expect(loaded?.status).toBe("completed");
    expect(client.store.size).toBe(1);
  });

  it("should delete a snapshot", async () => {
    const client = makeFakeRedis();
    const store = redis({ client });

    await store.save(makeSnapshot());
    await store.delete("sess-1.unversioned.0");

    expect(await store.load("sess-1.unversioned.0")).toBeUndefined();
  });

  it("should namespace keys under the default prefix", async () => {
    const client = makeFakeRedis();
    const store = redis({ client });

    await store.save(makeSnapshot({ runId: "sess-1.unversioned.0" }));

    expect(
      client.store.has("warlock:supervisor:snapshot:sess-1.unversioned.0"),
    ).toBe(true);
  });

  it("should honor a custom key prefix", async () => {
    const client = makeFakeRedis();
    const store = redis({ client, prefix: "app:snap:" });

    await store.save(makeSnapshot({ runId: "r1" }));

    expect(client.store.has("app:snap:r1")).toBe(true);
    expect(await store.load("r1")).toBeDefined();
  });

  it("should not implement the optional list()", () => {
    const client = makeFakeRedis();
    const store = redis({ client });

    expect(store.list).toBeUndefined();
  });

  it("should expose an empty schema", () => {
    const client = makeFakeRedis();
    const store = redis({ client });

    expect(store.schema()).toBe("");
  });

  it("should reject a missing client", () => {
    expect(() =>
      redis({ client: undefined as unknown as RedisClientLike }),
    ).toThrow(/requires a 'client'/);
  });

  it("should reject a client missing required methods", () => {
    expect(() =>
      redis({
        client: { get: async () => null } as unknown as RedisClientLike,
      }),
    ).toThrow(/requires a 'client'/);
  });
});
