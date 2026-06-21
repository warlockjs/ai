import { describe, expect, it } from "vitest";
import type { SupervisorSnapshot } from "../contracts/supervisor/supervisor-snapshot.type";
import { memory } from "./memory";

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

describe("snapshot memory store", () => {
  it("should return undefined for an unknown runId", async () => {
    const store = memory();

    const loaded = await store.load("missing");

    expect(loaded).toBeUndefined();
  });

  it("should round-trip a saved snapshot", async () => {
    const store = memory();
    const snapshot = makeSnapshot({ iteration: 3 });

    await store.save(snapshot);
    const loaded = await store.load("sess-1.unversioned.0");

    expect(loaded).toEqual(snapshot);
  });

  it("should overwrite the snapshot for the same runId", async () => {
    const store = memory();

    await store.save(makeSnapshot({ iteration: 0, status: "running" }));
    await store.save(makeSnapshot({ iteration: 1, status: "completed" }));

    const loaded = await store.load("sess-1.unversioned.0");

    expect(loaded?.iteration).toBe(1);
    expect(loaded?.status).toBe("completed");
  });

  it("should delete a snapshot", async () => {
    const store = memory();

    await store.save(makeSnapshot());
    await store.delete("sess-1.unversioned.0");

    expect(await store.load("sess-1.unversioned.0")).toBeUndefined();
  });

  it("should list known run ids", async () => {
    const store = memory();

    await store.save(makeSnapshot({ runId: "a.unversioned.0" }));
    await store.save(makeSnapshot({ runId: "b.unversioned.0" }));

    const runIds = await store.list?.();

    expect(runIds?.sort()).toEqual(["a.unversioned.0", "b.unversioned.0"]);
  });

  it("should filter listed run ids by prefix", async () => {
    const store = memory();

    await store.save(makeSnapshot({ runId: "sess-1.v1.0" }));
    await store.save(makeSnapshot({ runId: "sess-1.v1.1" }));
    await store.save(makeSnapshot({ runId: "sess-2.v1.0" }));

    const runIds = await store.list?.("sess-1.");

    expect(runIds?.sort()).toEqual(["sess-1.v1.0", "sess-1.v1.1"]);
  });

  it("should expose an empty schema for the memory store", () => {
    const store = memory();

    expect(store.schema()).toBe("");
  });
});
