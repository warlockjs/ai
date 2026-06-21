import { beforeEach, describe, expect, it, vi } from "vitest";
import { END } from "../contracts/end.type";
import type { CheckpointStore } from "../contracts/orchestrator/checkpoint-store.contract";
import type { Message } from "../contracts/conversation-message.type";
import { checkpointMemory } from "../checkpoint";
import { OrchestratorDriftError } from "../errors";
import { orchestrator } from "./orchestrator";

/**
 * Lifecycle (C2 engine) integration tests — drive the real
 * C1-factory → C2-engine path (`ai.orchestrator(...).execute()`),
 * exercising every phase of orchestrator.md §3 against the in-memory
 * checkpoint store. `iterate` defaults to `false`, so each turn is a
 * single supervisor dispatch (`maxIterations: 1`) — no snapshot store
 * needed.
 */

type CounterState = {
  count: number;
  lastInput?: string;
};

const HISTORY: Message[] = [
  { role: "user", content: "first" },
  { role: "assistant", content: "ack" },
  { role: "user", content: "second" },
];

/**
 * Build a minimal `iterate: false` orchestrator whose single `run`
 * intent increments a session-state counter — enough to assert state
 * carries across turns and the checkpoint advances.
 */
function buildCounter(checkpointStore: CheckpointStore) {
  return orchestrator<CounterState, CounterState>({
    name: "counter",
    state: { count: 0 },
    intents: {
      bump: {
        run: async (ctx) => ({
          count: ((ctx.state as CounterState).count ?? 0) + 1,
          lastInput: ctx.input as string,
        }),
        description: "Increment the session counter",
        next: () => END,
      },
    },
    route: (ctx) => (ctx.iteration === 0 ? "bump" : END),
    checkpointStore,
  });
}

describe("orchestrator lifecycle — happy path", () => {
  let store: CheckpointStore;

  beforeEach(() => {
    store = checkpointMemory();
  });

  it("runs a turn, returns turnIndex 0, and persists a checkpoint (Phase 1/5/6)", async () => {
    const orch = buildCounter(store);

    const result = await orch.execute("hello", {
      sessionId: "s1",
      history: HISTORY,
    });

    expect(result.error).toBeUndefined();
    expect(result.sessionId).toBe("s1");
    expect(result.turnIndex).toBe(0);
    expect(result.report.type).toBe("orchestrator");

    const persisted = await store.load("counter", "s1");
    expect(persisted?.turn_index).toBe(0);
    expect(persisted?.signature).toBe(orch.signature);
  });

  it("reports a clean turn as awaiting-input (non-terminal §15.6)", async () => {
    const orch = buildCounter(store);

    const result = await orch.execute("hello", {
      sessionId: "s1",
      history: [],
    });

    expect(result.report.status).toBe("awaiting-input");
  });

  it("rehydrates state and advances turn_index across turns (Phase 1)", async () => {
    const orch = buildCounter(store);

    await orch.execute("one", { sessionId: "s1", history: [] });
    const second = await orch.execute("two", { sessionId: "s1", history: [] });

    expect(second.turnIndex).toBe(1);

    const latest = await store.load("counter", "s1");
    expect((latest?.state as CounterState).count).toBe(2);
    expect((latest?.state as CounterState).lastInput).toBe("two");
  });

  it("seeds first-call state from config.state, not on subsequent turns (Phase 1)", async () => {
    const orch = buildCounter(store);

    const first = await orch.execute("one", { sessionId: "fresh", history: [] });

    expect((first.report.turns[0]?.state as CounterState).count).toBe(1);
  });

  it("applies the per-call state patch over the loaded seed (§5)", async () => {
    const orch = buildCounter(store);

    const result = await orch.execute("one", {
      sessionId: "s1",
      history: [],
      state: { count: 41 },
    });

    const latest = await store.load("counter", "s1");
    expect((latest?.state as CounterState).count).toBe(42);
    expect(result.turnIndex).toBe(0);
  });

  it("isolates sessions by sessionId", async () => {
    const orch = buildCounter(store);

    await orch.execute("a", { sessionId: "alice", history: [] });
    await orch.execute("b", { sessionId: "bob", history: [] });
    await orch.execute("a2", { sessionId: "alice", history: [] });

    const alice = await store.load("counter", "alice");
    const bob = await store.load("counter", "bob");

    expect((alice?.state as CounterState).count).toBe(2);
    expect((bob?.state as CounterState).count).toBe(1);
  });
});

describe("orchestrator lifecycle — drift check (Phase 2)", () => {
  it("throws OrchestratorDriftError when the signature changed", async () => {
    const store = checkpointMemory();

    const original = buildCounter(store);
    await original.execute("seed", { sessionId: "s1", history: [] });

    // A structurally different definition produces a different signature.
    const drifted = orchestrator<CounterState, CounterState>({
      name: "counter",
      state: { count: 0 },
      intents: {
        bump: {
          run: async () => ({ count: 0 }),
          description: "Increment the session counter",
          next: () => END,
        },
        extra: {
          run: async () => ({ count: 0 }),
          description: "An added intent that shifts the signature",
          next: () => END,
        },
      },
      route: (ctx) => (ctx.iteration === 0 ? "bump" : END),
      checkpointStore: store,
    });

    await expect(
      drifted.execute("again", { sessionId: "s1", history: [] }),
    ).rejects.toBeInstanceOf(OrchestratorDriftError);
  });

  it("bypasses drift with { force: true } and persists the new signature", async () => {
    const store = checkpointMemory();

    const original = buildCounter(store);
    await original.execute("seed", { sessionId: "s1", history: [] });

    const drifted = orchestrator<CounterState, CounterState>({
      name: "counter",
      state: { count: 0 },
      intents: {
        bump: {
          run: async () => ({ count: 99 }),
          description: "Increment the session counter",
          next: () => END,
        },
        extra: {
          run: async () => ({ count: 0 }),
          description: "An added intent that shifts the signature",
          next: () => END,
        },
      },
      route: (ctx) => (ctx.iteration === 0 ? "bump" : END),
      checkpointStore: store,
    });

    const result = await drifted.execute("again", {
      sessionId: "s1",
      history: [],
      force: true,
    });

    expect(result.error).toBeUndefined();

    const latest = await store.load("counter", "s1");
    expect(latest?.signature).toBe(drifted.signature);
  });

  it("never drifts on the first call (no loaded signature)", async () => {
    const orch = buildCounter(checkpointMemory());

    const result = await orch.execute("hello", {
      sessionId: "new",
      history: [],
    });

    expect(result.error).toBeUndefined();
  });
});

describe("orchestrator lifecycle — events", () => {
  it("emits the per-turn lifecycle events in order (§14.1)", async () => {
    const seen: string[] = [];
    const store = checkpointMemory();

    const orch = orchestrator<CounterState, CounterState>({
      name: "counter",
      state: { count: 0 },
      intents: {
        bump: {
          run: async () => ({ count: 1 }),
          description: "Increment the session counter",
          next: () => END,
        },
      },
      route: (ctx) => (ctx.iteration === 0 ? "bump" : END),
      checkpointStore: store,
      on: {
        "orchestrator.turn.starting": () => seen.push("starting"),
        "orchestrator.session.loaded": () => seen.push("loaded"),
        "orchestrator.drift.checked": () => seen.push("drift"),
        "orchestrator.history.windowed": () => seen.push("windowed"),
        "orchestrator.checkpoint.persisted": () => seen.push("persisted"),
      },
    });

    await orch.execute("hi", { sessionId: "s1", history: HISTORY });

    expect(seen).toEqual([
      "starting",
      "loaded",
      "drift",
      "windowed",
      "persisted",
    ]);
  });

  it("fires per-call (tier 3) handlers and unbinds them after the turn", async () => {
    const store = checkpointMemory();
    const orch = buildCounter(store);
    const handler = vi.fn();

    await orch.execute("hi", {
      sessionId: "s1",
      history: [],
      on: { "orchestrator.checkpoint.persisted": handler },
    });

    expect(handler).toHaveBeenCalledTimes(1);

    // A second turn without the per-call handler must not re-fire it.
    await orch.execute("hi again", { sessionId: "s1", history: [] });

    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("orchestrator lifecycle — compaction (Phase 7)", () => {
  it("surfaces a compaction once afterTurns is crossed and invokes onCompact", async () => {
    const store = checkpointMemory();
    const onCompact = vi.fn();

    const orch = orchestrator<CounterState, CounterState>({
      name: "counter",
      state: { count: 0 },
      intents: {
        bump: {
          run: async () => ({ count: 1 }),
          description: "Increment the session counter",
          next: () => END,
        },
      },
      route: (ctx) => (ctx.iteration === 0 ? "bump" : END),
      checkpointStore: store,
      summarize: {
        afterTurns: 0,
        keep: 1,
        onCompact,
      },
    });

    const result = await orch.execute("hi", {
      sessionId: "s1",
      history: HISTORY,
    });

    expect(result.compaction).toBeDefined();
    expect(result.compaction?.summary.role).toBe("system");
    expect(onCompact).toHaveBeenCalledTimes(1);

    const latest = await store.load("counter", "s1");
    expect(latest?.summarized_through).toBe(result.compaction?.replacesToIndex);
  });

  it("does not compact when afterTurns is not reached", async () => {
    const store = checkpointMemory();

    const orch = orchestrator<CounterState, CounterState>({
      name: "counter",
      state: { count: 0 },
      intents: {
        bump: {
          run: async () => ({ count: 1 }),
          description: "Increment the session counter",
          next: () => END,
        },
      },
      route: (ctx) => (ctx.iteration === 0 ? "bump" : END),
      checkpointStore: store,
      summarize: { afterTurns: 50, keep: 1 },
    });

    const result = await orch.execute("hi", {
      sessionId: "s1",
      history: HISTORY,
    });

    expect(result.compaction).toBeUndefined();
  });
});

describe("orchestrator lifecycle — resume (§9)", () => {
  it("returns null for an iterate:false orchestrator (nothing to resume)", async () => {
    const orch = buildCounter(checkpointMemory());

    await orch.execute("hi", { sessionId: "s1", history: [] });

    const resumed = await orch.resume("s1");

    expect(resumed).toBeNull();
  });

  it("returns null when the session has no in-flight turn", async () => {
    const orch = buildCounter(checkpointMemory());

    const resumed = await orch.resume("never-seen");

    expect(resumed).toBeNull();
  });
});

describe("orchestrator lifecycle — manual compact command (§11)", () => {
  it("produces a CompactionResult over the supplied history", async () => {
    const orch = orchestrator<CounterState, CounterState>({
      name: "counter",
      state: { count: 0 },
      intents: {
        bump: {
          run: async () => ({ count: 1 }),
          description: "Increment the session counter",
          next: () => END,
        },
      },
      route: (ctx) => (ctx.iteration === 0 ? "bump" : END),
      checkpointStore: checkpointMemory(),
      summarize: { keep: 1 },
    });

    const compaction = await orch.command("compact", {
      sessionId: "s1",
      history: HISTORY,
    });

    expect(compaction.summary.role).toBe("system");
    expect(compaction.replacesFromIndex).toBe(0);
    expect(compaction.replacesToIndex).toBe(HISTORY.length - 1 - 1);
  });
});
