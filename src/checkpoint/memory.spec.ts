import { describe, expect, it } from "vitest";
import type { CheckpointRecord } from "../contracts/orchestrator/checkpoint-store.contract";
import { memory } from "./memory";

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

describe("checkpoint memory store", () => {
  it("should return undefined for an unknown session", async () => {
    const store = memory();

    const loaded = await store.load("support", "missing");

    expect(loaded).toBeUndefined();
  });

  it("should round-trip a saved checkpoint", async () => {
    const store = memory();
    const record = makeRecord({ state: { count: 7 } });

    await store.save(record);
    const loaded = await store.load("support", "sess-1");

    expect(loaded).toEqual(record);
  });

  it("should return the latest turn for a session", async () => {
    const store = memory();

    await store.save(makeRecord({ turn_index: 0, state: { count: 0 } }));
    await store.save(makeRecord({ turn_index: 1, state: { count: 1 } }));
    await store.save(makeRecord({ turn_index: 2, state: { count: 2 } }));

    const loaded = await store.load("support", "sess-1");

    expect(loaded?.turn_index).toBe(2);
    expect(loaded?.state).toEqual({ count: 2 });
  });

  it("should keep rows append-only without overwriting prior turns", async () => {
    const store = memory();

    await store.save(makeRecord({ turn_index: 0 }));
    await store.save(makeRecord({ turn_index: 1 }));

    const sessionIds = await store.list?.("support");

    expect(sessionIds).toEqual(["sess-1"]);
    expect((await store.load("support", "sess-1"))?.turn_index).toBe(1);
  });

  it("should isolate sessions by orchestrator name and session id", async () => {
    const store = memory();

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

  it("should delete every row for a session", async () => {
    const store = memory();

    await store.save(makeRecord({ turn_index: 0 }));
    await store.save(makeRecord({ turn_index: 1 }));
    await store.delete("support", "sess-1");

    expect(await store.load("support", "sess-1")).toBeUndefined();
  });

  it("should list session ids scoped to an orchestrator", async () => {
    const store = memory();

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

  it("should filter listed sessions by prefix", async () => {
    const store = memory();

    await store.save(
      makeRecord({ orchestrator_name: "support", session_id: "user-1" }),
    );
    await store.save(
      makeRecord({ orchestrator_name: "support", session_id: "user-2" }),
    );
    await store.save(
      makeRecord({ orchestrator_name: "support", session_id: "guest-1" }),
    );

    const userSessions = await store.list?.("support", "user-");

    expect(userSessions?.sort()).toEqual(["user-1", "user-2"]);
  });

  it("should expose an empty schema for the memory store", () => {
    const store = memory();

    expect(store.schema()).toBe("");
  });

  it("should prune rows below keepBeforeTurnIndex while keeping the tail", async () => {
    const store = memory();

    await store.save(makeRecord({ turn_index: 0, state: { count: 0 } }));
    await store.save(makeRecord({ turn_index: 1, state: { count: 1 } }));
    await store.save(makeRecord({ turn_index: 2, state: { count: 2 } }));

    // Keep only turn_index >= 2 — drops turns 0 and 1.
    await store.prune?.("support", "sess-1", 2);

    // The latest (turn 2) survives and still loads.
    const latest = await store.load("support", "sess-1");
    expect(latest?.turn_index).toBe(2);
    expect(latest?.state).toEqual({ count: 2 });

    // The session is still listed (its tail row remains).
    expect((await store.list?.("support"))?.sort()).toEqual(["sess-1"]);

    // A second prune at the same bound is a no-op (idempotent).
    await store.prune?.("support", "sess-1", 2);
    expect((await store.load("support", "sess-1"))?.turn_index).toBe(2);
  });

  it("should drop the session entirely when prune keeps no rows", async () => {
    const store = memory();

    await store.save(makeRecord({ turn_index: 0 }));
    await store.save(makeRecord({ turn_index: 1 }));

    // keepBeforeTurnIndex above the highest turn removes every row.
    await store.prune?.("support", "sess-1", 5);

    expect(await store.load("support", "sess-1")).toBeUndefined();
    expect(await store.list?.("support")).toEqual([]);
  });

  it("should be a no-op when pruning an unknown session", async () => {
    const store = memory();

    await expect(
      store.prune?.("support", "never-seen", 3),
    ).resolves.toBeUndefined();
  });
});
