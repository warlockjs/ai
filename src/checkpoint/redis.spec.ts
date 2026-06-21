import { describe, expect, it } from "vitest";
import type { CheckpointRecord } from "../contracts/orchestrator/checkpoint-store.contract";
import type { RedisClientLike } from "../contracts/orchestrator/snapshot-store.contract";
import { redis } from "./redis";

/**
 * In-memory {@link RedisClientLike} — a `Map`-backed string KV with the
 * minimal `get` / `set` / `del` surface the contract declares (§8.4).
 * Captures the last `set` options arg so a test can assert TTL is
 * threaded through.
 */
class FakeRedisClient implements RedisClientLike {
  public store = new Map<string, string>();

  public lastSetArgs: unknown[] = [];

  public async get(key: string): Promise<string | null> {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  public async set(
    key: string,
    value: string,
    ...args: unknown[]
  ): Promise<unknown> {
    this.store.set(key, value);
    this.lastSetArgs = args;

    return "OK";
  }

  public async del(key: string): Promise<number> {
    const existed = this.store.delete(key);

    return existed ? 1 : 0;
  }
}

function makeRecord(
  overrides: Partial<CheckpointRecord> = {},
): CheckpointRecord {
  return {
    orchestrator_name: "support",
    session_id: "sess-1",
    turn_index: 0,
    state: { count: 0 },
    last_route: null,
    signature: "sig-abc",
    version: null,
    summarized_through: null,
    lock_acquired_at: null,
    lock_expires_at: null,
    saved_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("checkpoint redis store", () => {
  it("should throw when no client is provided", () => {
    expect(() => redis({} as never)).toThrow(/client/);
  });

  it("should expose an empty schema for the redis store", () => {
    const store = redis({ client: new FakeRedisClient() });

    expect(store.schema()).toBe("");
  });

  it("should return undefined for an unknown session", async () => {
    const store = redis({ client: new FakeRedisClient() });

    const loaded = await store.load("support", "missing");

    expect(loaded).toBeUndefined();
  });

  it("should round-trip a saved checkpoint", async () => {
    const store = redis({ client: new FakeRedisClient() });
    const record = makeRecord({ state: { count: 7 } });

    await store.save(record);
    const loaded = await store.load("support", "sess-1");

    expect(loaded).toEqual(record);
  });

  it("should return the latest turn for a session", async () => {
    const store = redis({ client: new FakeRedisClient() });

    await store.save(makeRecord({ turn_index: 0, state: { count: 0 } }));
    await store.save(makeRecord({ turn_index: 1, state: { count: 1 } }));
    await store.save(makeRecord({ turn_index: 2, state: { count: 2 } }));

    const loaded = await store.load("support", "sess-1");

    expect(loaded?.turn_index).toBe(2);
    expect(loaded?.state).toEqual({ count: 2 });
  });

  it("should keep rows append-only without overwriting prior turns", async () => {
    const store = redis({ client: new FakeRedisClient() });

    await store.save(makeRecord({ turn_index: 0 }));
    await store.save(makeRecord({ turn_index: 1 }));

    expect((await store.load("support", "sess-1"))?.turn_index).toBe(1);
  });

  it("should round-trip a fan-out last_route array", async () => {
    const store = redis({ client: new FakeRedisClient() });

    await store.save(makeRecord({ last_route: ["lookup", "process"] }));
    const loaded = await store.load("support", "sess-1");

    expect(loaded?.last_route).toEqual(["lookup", "process"]);
  });

  it("should isolate sessions by orchestrator name and session id", async () => {
    const store = redis({ client: new FakeRedisClient() });

    await store.save(
      makeRecord({ orchestrator_name: "support", session_id: "a" }),
    );
    await store.save(
      makeRecord({ orchestrator_name: "billing", session_id: "a" }),
    );

    const supportSession = await store.load("support", "a");
    const billingSession = await store.load("billing", "a");

    expect(supportSession?.orchestrator_name).toBe("support");
    expect(billingSession?.orchestrator_name).toBe("billing");
  });

  it("should delete a session and de-index it", async () => {
    const store = redis({ client: new FakeRedisClient() });

    await store.save(makeRecord({ turn_index: 0 }));
    await store.save(makeRecord({ turn_index: 1 }));
    await store.delete("support", "sess-1");

    expect(await store.load("support", "sess-1")).toBeUndefined();
    expect(await store.list?.("support")).toEqual([]);
  });

  it("should list session ids scoped to an orchestrator", async () => {
    const store = redis({ client: new FakeRedisClient() });

    await store.save(
      makeRecord({ orchestrator_name: "support", session_id: "a" }),
    );
    await store.save(
      makeRecord({ orchestrator_name: "support", session_id: "b" }),
    );
    await store.save(
      makeRecord({ orchestrator_name: "billing", session_id: "c" }),
    );

    const supportSessions = await store.list?.("support");

    expect(supportSessions?.sort()).toEqual(["a", "b"]);
  });

  it("should not duplicate a session id in the index across turns", async () => {
    const store = redis({ client: new FakeRedisClient() });

    await store.save(makeRecord({ turn_index: 0 }));
    await store.save(makeRecord({ turn_index: 1 }));
    await store.save(makeRecord({ turn_index: 2 }));

    expect(await store.list?.("support")).toEqual(["sess-1"]);
  });

  it("should filter listed sessions by prefix", async () => {
    const store = redis({ client: new FakeRedisClient() });

    await store.save(makeRecord({ session_id: "user-1" }));
    await store.save(makeRecord({ session_id: "user-2" }));
    await store.save(makeRecord({ session_id: "guest-1" }));

    const userSessions = await store.list?.("support", "user-");

    expect(userSessions?.sort()).toEqual(["user-1", "user-2"]);
  });

  it("should prune turns below max - keepSnapshots", async () => {
    const store = redis({ client: new FakeRedisClient() });

    for (let turn = 0; turn <= 5; turn++) {
      await store.save(makeRecord({ turn_index: turn }));
    }

    const pruneable = store as unknown as {
      prune(name: string, sessionId: string, keep: number): Promise<void>;
    };
    await pruneable.prune("support", "sess-1", 2);

    const loaded = await store.load("support", "sess-1");
    expect(loaded?.turn_index).toBe(5);

    const all = store as unknown as {
      load(name: string, sessionId: string): Promise<CheckpointRecord>;
    };
    const latest = await all.load("support", "sess-1");
    expect(latest.turn_index).toBe(5);
  });

  it("should keep exactly the most recent turns after pruning", async () => {
    const client = new FakeRedisClient();
    const store = redis({ client });

    for (let turn = 0; turn <= 5; turn++) {
      await store.save(makeRecord({ turn_index: turn }));
    }

    const pruneable = store as unknown as {
      prune(name: string, sessionId: string, keep: number): Promise<void>;
    };
    await pruneable.prune("support", "sess-1", 2);

    const raw = await client.get(
      "warlock:orchestrator:session:support:sess-1",
    );
    const document = JSON.parse(raw as string) as {
      rows: CheckpointRecord[];
    };

    expect(document.rows.map((row) => row.turn_index)).toEqual([3, 4, 5]);
  });

  it("should attach the configured TTL to writes", async () => {
    const client = new FakeRedisClient();
    const store = redis({ client, ttl: 120 });

    await store.save(makeRecord());

    expect(client.lastSetArgs).toEqual([{ EX: 120 }]);
  });

  it("should honor a custom key prefix", async () => {
    const client = new FakeRedisClient();
    const store = redis({ client, prefix: "myapp" });

    await store.save(makeRecord());

    expect([...client.store.keys()]).toContain(
      "myapp:session:support:sess-1",
    );
  });
});
