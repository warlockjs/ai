import { beforeEach, describe, expect, it, vi } from "vitest";
import { END } from "../contracts/end.type";
import type { CheckpointRecord, CheckpointStore } from "../contracts/orchestrator/checkpoint-store.contract";
import type { SnapshotStore } from "../contracts/orchestrator/snapshot-store.contract";
import type { SupervisorSnapshot } from "../contracts/supervisor/supervisor-snapshot.type";
import { checkpointMemory } from "../checkpoint";
import { setAIConfig } from "../config";
import { OrchestratorConfigError, OrchestratorDriftError } from "../errors";
import { snapshotMemory } from "../snapshot";
import { orchestrator } from "./orchestrator";

/**
 * Failure-mode coverage for the orchestrator lifecycle (orchestrator.md
 * §17 failure table + §2/§3/§4 phase contracts). Each `describe` drives
 * one documented failure path against the in-memory stores:
 *
 * - Drift (§4 Phase 2, §10) — `OrchestratorDriftError` + `{ force }` bypass.
 * - Lock fail-open (§4 Phase 3, §12.3) — a stuck lock never blocks forever.
 * - Mid-turn cancel (§17 — "mid-turn cancel via AbortSignal") — the turn
 *   reverts to the pre-turn checkpoint; no fresh row is written.
 * - Resume drain (§9) — `null` when nothing is in flight; drains an
 *   interrupted `iterate: true` turn otherwise.
 * - `iterate: true` with no `snapshotStore` (§17) — construction throws
 *   `OrchestratorConfigError`.
 * - `keepSnapshots` pruning (§4 Phase 6, Q20) — prune is invoked with the
 *   retention bound, and `"all"` opts out.
 */

type CounterState = {
  count: number;
};

/**
 * A `CheckpointStore` that wraps the in-memory store and records every
 * `prune(orchestratorName, sessionId, keepBeforeTurnIndex)` call so a
 * test can assert the Phase-6 retention bound without reaching into the
 * memory store (which ships no prune hook).
 */
class RecordingCheckpointStore implements CheckpointStore {
  public readonly pruneCalls: Array<{
    orchestratorName: string;
    sessionId: string;
    keepBeforeTurnIndex: number;
  }> = [];

  private readonly inner: CheckpointStore = checkpointMemory();

  public async load(
    orchestratorName: string,
    sessionId: string,
  ): Promise<CheckpointRecord | undefined> {
    return this.inner.load(orchestratorName, sessionId);
  }

  public async save(record: CheckpointRecord): Promise<void> {
    await this.inner.save(record);
  }

  public async delete(
    orchestratorName: string,
    sessionId: string,
  ): Promise<void> {
    await this.inner.delete(orchestratorName, sessionId);
  }

  public async list(
    orchestratorName: string,
    prefix?: string,
  ): Promise<string[]> {
    return this.inner.list?.(orchestratorName, prefix) ?? [];
  }

  public schema(): string {
    return "";
  }

  public async prune(
    orchestratorName: string,
    sessionId: string,
    keepBeforeTurnIndex: number,
  ): Promise<void> {
    this.pruneCalls.push({ orchestratorName, sessionId, keepBeforeTurnIndex });
  }
}

/**
 * Minimal `iterate: false` counter orchestrator whose single `bump`
 * intent increments the session counter and ends. The default —
 * `maxIterations: 1`, no snapshot store needed.
 */
function buildCounter(
  checkpointStore: CheckpointStore,
  overrides: Partial<Parameters<typeof orchestrator<CounterState, CounterState>>[0]> = {},
) {
  return orchestrator<CounterState, CounterState>({
    name: "counter",
    state: { count: 0 },
    intents: {
      bump: {
        run: async (ctx) => ({ count: ((ctx.state as CounterState).count ?? 0) + 1 }),
        description: "Increment the session counter",
        next: () => END,
      },
    },
    route: (ctx) => (ctx.iteration === 0 ? "bump" : END),
    checkpointStore,
    ...overrides,
  });
}

describe("orchestrator failures — drift (§4 Phase 2 / §10)", () => {
  it("throws OrchestratorDriftError carrying both signatures and the sessionId", async () => {
    const store = checkpointMemory();

    const original = buildCounter(store);
    await original.execute("seed", { sessionId: "s1", history: [] });

    // An added intent shifts the structural signature.
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

    const error = await drifted
      .execute("again", { sessionId: "s1", history: [] })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(OrchestratorDriftError);

    const driftError = error as OrchestratorDriftError;
    expect(driftError.sessionId).toBe("s1");
    expect(driftError.savedSignature).toBe(original.signature);
    expect(driftError.currentSignature).toBe(drifted.signature);
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
          run: async () => ({ count: 7 }),
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

  it("never drifts on a brand-new session (no loaded signature)", async () => {
    const drifted = orchestrator<CounterState, CounterState>({
      name: "counter",
      state: { count: 0 },
      intents: {
        bump: {
          run: async () => ({ count: 1 }),
          description: "Increment the session counter",
          next: () => END,
        },
        extra: {
          run: async () => ({ count: 0 }),
          description: "shifts signature vs the bare counter",
          next: () => END,
        },
      },
      route: (ctx) => (ctx.iteration === 0 ? "bump" : END),
      checkpointStore: checkpointMemory(),
    });

    const result = await drifted.execute("hi", { sessionId: "fresh", history: [] });

    expect(result.error).toBeUndefined();
  });
});

describe("orchestrator failures — lock fail-open (§4 Phase 3 / §12.3)", () => {
  it("waits up to maxWait on a held lock, then fails open and runs the turn", async () => {
    const store = checkpointMemory();

    // Seed a settled turn 0 whose row still carries a live compaction
    // lock (lock_expires_at far in the future) — as if a prior turn's
    // Phase 7 compaction is still in flight.
    const farFuture = new Date(Date.now() + 60_000).toISOString();
    const orch = buildCounter(store, {
      summarize: { lock: { maxWait: 60 } },
    });

    await store.save({
      orchestrator_name: "counter",
      session_id: "locked",
      turn_index: 0,
      state: { count: 5 },
      last_route: "bump",
      signature: orch.signature,
      version: null,
      summarized_through: null,
      lock_acquired_at: new Date().toISOString(),
      lock_expires_at: farFuture,
      saved_at: new Date().toISOString(),
    });

    const waited: number[] = [];
    const startedAt = Date.now();

    const result = await orch.execute("go", {
      sessionId: "locked",
      history: [],
      on: {
        "orchestrator.lock.waiting": (payload) => waited.push(payload.waitedMs),
      },
    });

    // Fail-open: the turn proceeds despite the live lock.
    expect(result.error).toBeUndefined();
    expect(result.turnIndex).toBe(1);

    // A held lock was observed (the waiting event fired) and the wait was
    // bounded by maxWait rather than the lock's 60s TTL.
    expect(waited.length).toBeGreaterThan(0);
    expect(Date.now() - startedAt).toBeLessThan(60_000);

    // The fresh turn 1 carries the incremented state (run against the
    // pre-lock state of count 5).
    const latest = await store.load("counter", "locked");
    expect(latest?.turn_index).toBe(1);
    expect((latest?.state as CounterState).count).toBe(6);
  });
});

describe("orchestrator failures — mid-turn cancel (§17 / Q10)", () => {
  it("reverts to the pre-turn checkpoint and writes no fresh row when aborted mid-iteration", async () => {
    const checkpointStore = checkpointMemory();
    const snapshotStore = snapshotMemory();
    const controller = new AbortController();
    let arming = false;

    const orch = orchestrator<CounterState, CounterState>({
      name: "cancellable",
      state: { count: 0 },
      iterate: true,
      maxIterations: 50,
      intents: {
        bump: {
          run: async (ctx) => ({ count: ((ctx.state as CounterState).count ?? 0) + 1 }),
          description: "Increment the session counter",
        },
      },
      // Between-iteration cancellation is the supervisor's guaranteed
      // cancellation point — keep the loop going, then abort after the
      // first iteration on the targeted ("go") turn only.
      route: async (ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 10));

        if (!arming) {
          return ctx.iteration >= 1 ? END : "bump";
        }

        if (ctx.iteration === 1) {
          controller.abort("user navigated away");
        }

        return "bump";
      },
      checkpointStore,
      snapshotStore,
    });

    // Seed a clean turn 0 — the pre-turn checkpoint the cancel must revert to.
    await orch.execute("seed", { sessionId: "s1", history: [] });
    const before = await checkpointStore.load("cancellable", "s1");
    expect(before?.turn_index).toBe(0);

    arming = true;
    const result = await orch.execute("go", {
      sessionId: "s1",
      history: [],
      signal: controller.signal,
    });

    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe("SUPERVISOR_CANCELLED");
    expect(result.report.status).toBe("cancelled");
    expect(result.turnIndex).toBe(1);

    // Revert: the latest checkpoint is still turn 0 — no fresh row for the
    // aborted turn (§17 — state reverts to the pre-turn checkpoint).
    const after = await checkpointStore.load("cancellable", "s1");
    expect(after?.turn_index).toBe(0);
    expect((after?.state as CounterState).count).toBe(
      (before?.state as CounterState).count,
    );
  });

  it("emits orchestrator.turn.cancelled for the aborted turn", async () => {
    const controller = new AbortController();
    const cancelled = vi.fn();

    const orch = buildCounter(checkpointMemory());

    // Abort before the turn starts — the dispatch observes the aborted
    // signal and surfaces a cancelled result without throwing.
    controller.abort("stop");

    const result = await orch.execute("go", {
      sessionId: "s1",
      history: [],
      signal: controller.signal,
      on: { "orchestrator.turn.cancelled": cancelled },
    });

    expect(result.report.status).toBe("cancelled");
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
});

describe("orchestrator failures — resume drain (§9)", () => {
  it("returns null when the session has no in-flight turn", async () => {
    const orch = buildCounter(checkpointMemory());

    const resumed = await orch.resume("never-seen");

    expect(resumed).toBeNull();
  });

  it("returns null for an iterate:false orchestrator (nothing to snapshot)", async () => {
    const orch = buildCounter(checkpointMemory());

    await orch.execute("hi", { sessionId: "s1", history: [] });

    const resumed = await orch.resume("s1");

    expect(resumed).toBeNull();
  });

  it("drains an interrupted iterate:true turn and persists the resumed checkpoint", async () => {
    const checkpointStore = checkpointMemory();
    const snapshotStore = snapshotMemory();

    const orch = orchestrator<CounterState, CounterState>({
      name: "drainable",
      state: { count: 0 },
      iterate: true,
      intents: {
        bump: {
          run: async (ctx) => ({ count: ((ctx.state as CounterState).count ?? 0) + 1 }),
          description: "Increment the session counter",
          next: () => END,
        },
      },
      route: (ctx) => (ctx.iteration === 0 ? "bump" : END),
      checkpointStore,
      snapshotStore,
    });

    // Run a real turn 0 so the framework writes a genuine snapshot
    // (carrying the real internal-supervisor signature) at the turn-0 runId.
    await orch.execute("hi", { sessionId: "s1", history: [] });
    const real = await snapshotStore.load("s1.unversioned.0");
    expect(real).toBeDefined();

    // Forge the in-flight snapshot for the NEXT turn's runId by cloning
    // the real one back to `running` — simulating a turn-1 iteration that
    // crashed mid-flight. Reusing the real signature keeps the
    // supervisor's own resume drift check happy.
    const inflight: SupervisorSnapshot = {
      ...(real as SupervisorSnapshot),
      runId: "s1.unversioned.1",
      status: "running",
    };
    await snapshotStore.save(inflight);

    const resumed = await orch.resume("s1");

    expect(resumed).not.toBeNull();
    expect(resumed?.error).toBeUndefined();
    expect(resumed?.turnIndex).toBe(1);
    expect(resumed?.report.status).toBe("awaiting-input");

    // A fresh checkpoint for the drained turn 1 landed.
    const latest = await checkpointStore.load("drainable", "s1");
    expect(latest?.turn_index).toBe(1);
  });

  it("re-checks drift on resume and throws OrchestratorDriftError on mismatch", async () => {
    const checkpointStore = checkpointMemory();
    const snapshotStore = snapshotMemory();

    const base = {
      name: "drift-on-resume",
      state: { count: 0 },
      iterate: true as const,
      intents: {
        bump: {
          run: async () => ({ count: 1 }),
          description: "Increment the session counter",
          next: () => END,
        },
      },
      route: (ctx: { iteration: number }) => (ctx.iteration === 0 ? "bump" : END),
      checkpointStore,
      snapshotStore,
    };

    const original = orchestrator<CounterState, CounterState>(base);
    await original.execute("hi", { sessionId: "s1", history: [] });

    // A structurally different definition over the same session checkpoint.
    const drifted = orchestrator<CounterState, CounterState>({
      ...base,
      intents: {
        ...base.intents,
        extra: {
          run: async () => ({ count: 0 }),
          description: "An added intent that shifts the signature",
          next: () => END,
        },
      },
    });

    await expect(drifted.resume("s1")).rejects.toBeInstanceOf(
      OrchestratorDriftError,
    );
  });
});

describe("orchestrator failures — iterate:true without a snapshotStore (§17)", () => {
  beforeEach(() => {
    // The default snapshot store is process-global — clear it so a stray
    // config from another suite can't satisfy the iterate:true guard.
    setAIConfig({ defaultSnapshotStore: undefined });
  });

  it("throws OrchestratorConfigError at construction", () => {
    expect(() =>
      orchestrator<CounterState, CounterState>({
        name: "needs-snapshot",
        state: { count: 0 },
        iterate: true,
        intents: {
          bump: {
            run: async () => ({ count: 1 }),
            description: "Increment the session counter",
            next: () => END,
          },
        },
        route: (ctx) => (ctx.iteration === 0 ? "bump" : END),
        checkpointStore: checkpointMemory(),
        // snapshotStore intentionally omitted.
      }),
    ).toThrow(OrchestratorConfigError);
  });

  it("constructs cleanly once ai.config({ defaultSnapshotStore }) resolves the fallback", () => {
    setAIConfig({ defaultSnapshotStore: snapshotMemory() });

    try {
      expect(() =>
        orchestrator<CounterState, CounterState>({
          name: "default-snapshot",
          state: { count: 0 },
          iterate: true,
          intents: {
            bump: {
              run: async () => ({ count: 1 }),
              description: "Increment the session counter",
              next: () => END,
            },
          },
          route: (ctx) => (ctx.iteration === 0 ? "bump" : END),
          checkpointStore: checkpointMemory(),
        }),
      ).not.toThrow();
    } finally {
      setAIConfig({ defaultSnapshotStore: undefined });
    }
  });
});

describe("orchestrator failures — keepSnapshots pruning (§4 Phase 6 / Q20)", () => {
  it("invokes the store prune hook with the retention bound after a save", async () => {
    const store = new RecordingCheckpointStore();
    const orch = buildCounter(store, { keepSnapshots: 1 });

    // Turn 0 — max_turn_index (0) - keep (1) + 1 = 0, so prune is skipped.
    await orch.execute("one", { sessionId: "s1", history: [] });
    expect(store.pruneCalls).toHaveLength(0);

    // Turn 1 — max_turn_index (1) - keep (1) + 1 = 1, so prune fires with
    // the bound 1 (drop every row before turn_index 1).
    await orch.execute("two", { sessionId: "s1", history: [] });

    expect(store.pruneCalls).toHaveLength(1);
    expect(store.pruneCalls[0]).toEqual({
      orchestratorName: "counter",
      sessionId: "s1",
      keepBeforeTurnIndex: 1,
    });
  });

  it('never prunes when keepSnapshots is "all"', async () => {
    const store = new RecordingCheckpointStore();
    const orch = buildCounter(store, { keepSnapshots: "all" });

    await orch.execute("one", { sessionId: "s1", history: [] });
    await orch.execute("two", { sessionId: "s1", history: [] });
    await orch.execute("three", { sessionId: "s1", history: [] });

    expect(store.pruneCalls).toHaveLength(0);
  });
});
