import { beforeEach, describe, expect, it, vi } from "vitest";
import { ai } from "../ai";
import type { Message } from "../contracts/conversation-message.type";
import { END } from "../contracts/end.type";
import type { CheckpointStore } from "../contracts/orchestrator/checkpoint-store.contract";
import type { OrchestratorEvent } from "../contracts/orchestrator/orchestrator-event.type";
import type { SnapshotStore } from "../contracts/orchestrator/snapshot-store.contract";
import type { OrchestratorResult } from "../contracts/result/orchestrator-result.type";
import { MockSDK } from "../mock/mock-sdk";
import { schema } from "../supervisor/_test-helpers";

/** Pass-through string schema for an `asTool` "fresh"-scope payload. */
const stringSchema = schema<string>((value) =>
  typeof value === "string"
    ? { value }
    : { issues: [{ message: "expected a string" }] },
);

/** Pass-through object schema for an `asTool` "shared"-scope payload. */
const objectSchema = schema<Record<string, unknown>>((value) =>
  typeof value === "object" && value !== null
    ? { value: value as Record<string, unknown> }
    : { issues: [{ message: "expected an object" }] },
);

/**
 * Public-surface happy-path suite for `ai.orchestrator(...)` (T1). Drives
 * the real factory → engine path against the in-memory checkpoint /
 * snapshot stores (`ai.checkpoint.memory()` / `ai.snapshot.memory()`)
 * and `MockSDK` — no network, no real LLM. Exercises the orchestrator.md
 * §3 lifecycle from the consumer's side: first-call seed + persist,
 * multi-turn state carry-over, `iterate: false` single dispatch,
 * `iterate: true` delegation to the internal supervisor, the
 * `historyWindow` cascade, post-turn compaction, `asTool()` session
 * scoping, the 3-tier event order, and `stream()`.
 *
 * The lifecycle-internals suite lives next door in `execution.spec.ts`;
 * this file asserts the contract a downstream dev sees.
 */

type CounterState = {
  count: number;
  lastInput?: string;
  via?: string;
};

const HISTORY: Message[] = [
  { role: "user", content: "first" },
  { role: "assistant", content: "ack" },
  { role: "user", content: "second" },
  { role: "assistant", content: "ack-2" },
  { role: "user", content: "third" },
];

/**
 * Build a minimal `iterate: false` orchestrator whose single `bump`
 * intent increments a session-state counter and records the input —
 * enough to assert state seeds, carries across turns, and the checkpoint
 * advances. No model needed; the `route` callback drives dispatch
 * deterministically.
 */
function buildCounter(checkpointStore: CheckpointStore) {
  return ai.orchestrator<CounterState, CounterState>({
    name: "counter",
    state: { count: 0 },
    intents: {
      bump: {
        run: async (context) => ({
          count: ((context.state as CounterState).count ?? 0) + 1,
          lastInput: context.input as string,
        }),
        description: "Increment the session counter",
        next: () => END,
      },
    },
    route: (context) => (context.iteration === 0 ? "bump" : END),
    checkpointStore,
  });
}

describe("ai.orchestrator() — first call (seed + persist)", () => {
  let store: CheckpointStore;

  beforeEach(() => {
    store = ai.checkpoint.memory();
  });

  it("seeds state from config.state, runs turn 0, and persists a checkpoint", async () => {
    const orchestrator = buildCounter(store);

    const result = await orchestrator.execute("hello", {
      sessionId: "s1",
      history: HISTORY,
    });

    expect(result.error).toBeUndefined();
    expect(result.sessionId).toBe("s1");
    expect(result.turnIndex).toBe(0);
    expect(result.report.type).toBe("orchestrator");
    expect((result.report.turns[0]?.state as CounterState).count).toBe(1);

    const persisted = await store.load("counter", "s1");
    expect(persisted?.turn_index).toBe(0);
    expect(persisted?.signature).toBe(orchestrator.signature);
    expect((persisted?.state as CounterState).lastInput).toBe("hello");
  });

  it("reports a clean turn as the non-terminal awaiting-input status (§15.6)", async () => {
    const orchestrator = buildCounter(store);

    const result = await orchestrator.execute("hello", {
      sessionId: "s1",
      history: [],
    });

    expect(result.report.status).toBe("awaiting-input");
  });

  it("applies the per-call partial state patch over the seed (§5)", async () => {
    const orchestrator = buildCounter(store);

    const result = await orchestrator.execute("one", {
      sessionId: "s1",
      history: [],
      state: { count: 41 },
    });

    expect(result.turnIndex).toBe(0);

    const persisted = await store.load("counter", "s1");
    expect((persisted?.state as CounterState).count).toBe(42);
  });
});

describe("ai.orchestrator() — multi-turn state carry-over", () => {
  let store: CheckpointStore;

  beforeEach(() => {
    store = ai.checkpoint.memory();
  });

  it("rehydrates state and advances turn_index across turns", async () => {
    const orchestrator = buildCounter(store);

    await orchestrator.execute("one", { sessionId: "s1", history: [] });
    const second = await orchestrator.execute("two", { sessionId: "s1", history: [] });
    const third = await orchestrator.execute("three", { sessionId: "s1", history: [] });

    expect(second.turnIndex).toBe(1);
    expect(third.turnIndex).toBe(2);

    const latest = await store.load("counter", "s1");
    expect((latest?.state as CounterState).count).toBe(3);
    expect((latest?.state as CounterState).lastInput).toBe("three");
  });

  it("does not re-seed config.state on subsequent turns", async () => {
    const orchestrator = buildCounter(store);

    await orchestrator.execute("one", { sessionId: "s1", history: [] });
    const second = await orchestrator.execute("two", { sessionId: "s1", history: [] });

    expect((second.report.turns[0]?.state as CounterState).count).toBe(2);
  });

  it("isolates sessions by sessionId", async () => {
    const orchestrator = buildCounter(store);

    await orchestrator.execute("a", { sessionId: "alice", history: [] });
    await orchestrator.execute("b", { sessionId: "bob", history: [] });
    await orchestrator.execute("a2", { sessionId: "alice", history: [] });

    const alice = await store.load("counter", "alice");
    const bob = await store.load("counter", "bob");

    expect((alice?.state as CounterState).count).toBe(2);
    expect((bob?.state as CounterState).count).toBe(1);
  });
});

describe("ai.orchestrator() — iterate:false single dispatch", () => {
  it("runs exactly one supervisor dispatch per turn (maxIterations capped at 1)", async () => {
    const orchestrator = buildCounter(ai.checkpoint.memory());

    const result = await orchestrator.execute("go", {
      sessionId: "s1",
      history: [],
    });

    // iterate:false caps the internal supervisor at a single iteration —
    // the child supervisor report records exactly one iteration.
    const childReport = result.report.turns[0]?.childReport as
      | { iterations?: number }
      | undefined;
    expect(childReport?.iterations).toBe(1);
    expect(result.report.children).toHaveLength(1);
  });

  it("does not require a snapshotStore when iterate is false", () => {
    expect(() => buildCounter(ai.checkpoint.memory())).not.toThrow();
  });

  it("dispatches a MockSDK-backed agent intent and surfaces its output", async () => {
    const sdk = MockSDK({
      responses: [{ content: "scripted reply", finishReason: "stop" }],
    });
    const model = sdk.model({ name: "echo-model" });
    const responder = ai.agent({ name: "responder", description: "replies", model });

    const orchestrator = ai.orchestrator<string, string>({
      name: "agent-intent",
      intents: {
        responder: { agent: responder, next: () => END },
      },
      route: (context) => (context.iteration === 0 ? "responder" : END),
      checkpointStore: ai.checkpoint.memory(),
    });

    const result = await orchestrator.execute("ping", {
      sessionId: "s1",
      history: [],
    });

    expect(result.error).toBeUndefined();
    // The scripted reply flows through the dispatched branch's output.
    expect(result.report.turns[0]?.result.responder?.output).toBe(
      "scripted reply",
    );
    // The mock model was hit exactly once for the single dispatch.
    expect(sdk.models[0].callCount).toBe(1);
  });
});

describe("ai.orchestrator() — iterate:true delegates to the internal supervisor", () => {
  let checkpointStore: CheckpointStore;
  let snapshotStore: SnapshotStore;

  beforeEach(() => {
    checkpointStore = ai.checkpoint.memory();
    snapshotStore = ai.snapshot.memory();
  });

  /**
   * `iterate: true` orchestrator that loops the internal supervisor: the
   * `route` callback dispatches `first` on iteration 0, `second` on
   * iteration 1, then ENDs — so the supervisor runs a real multi-step
   * in-turn loop the orchestrator delegates to (it never reimplements
   * the loop itself).
   */
  function buildIterating() {
    return ai.orchestrator<CounterState, CounterState>({
      name: "iterating",
      state: { count: 0 },
      intents: {
        first: {
          run: async (context) => ({
            count: ((context.state as CounterState).count ?? 0) + 1,
            via: "first",
          }),
          description: "First step",
        },
        second: {
          run: async (context) => ({
            count: ((context.state as CounterState).count ?? 0) + 1,
            via: "second",
          }),
          description: "Second step",
          next: () => END,
        },
      },
      route: (context) => {
        if (context.iteration === 0) {
          return "first";
        }

        if (context.iteration === 1) {
          return "second";
        }

        return END;
      },
      iterate: true,
      checkpointStore,
      snapshotStore,
    });
  }

  it("iterates the supervisor more than once within a single turn", async () => {
    const orchestrator = buildIterating();

    const result = await orchestrator.execute("go", {
      sessionId: "s1",
      history: [],
    });

    expect(result.error).toBeUndefined();

    const childReport = result.report.turns[0]?.childReport as
      | { iterations?: number }
      | undefined;
    expect(childReport?.iterations).toBeGreaterThan(1);

    // Both steps ran — the accumulator was incremented twice in-turn.
    const latest = await checkpointStore.load("iterating", "s1");
    expect((latest?.state as CounterState).count).toBe(2);
    expect((latest?.state as CounterState).via).toBe("second");
  });

  it("throws at construction when iterate:true has no snapshotStore", () => {
    expect(() =>
      ai.orchestrator<CounterState, CounterState>({
        name: "no-snapshot",
        state: { count: 0 },
        intents: {
          first: {
            run: async () => ({ count: 1 }),
            description: "step",
            next: () => END,
          },
        },
        route: () => END,
        iterate: true,
        checkpointStore,
      }),
    ).toThrow(/snapshotStore/);
  });
});

describe("ai.orchestrator() — historyWindow cascade (Phase 4)", () => {
  /**
   * Capture the agent-facing windowed history by reading the
   * `messageCount` carried on `orchestrator.history.windowed`. The
   * agents tier default is 15, so a 5-message history passes through
   * intact unless a tighter window is configured.
   */
  function buildWindowed(agentsWindow?: number) {
    return ai.orchestrator<CounterState, CounterState>({
      name: "windowed",
      state: { count: 0 },
      intents: {
        bump: {
          run: async () => ({ count: 1 }),
          description: "bump",
          next: () => END,
        },
      },
      route: (context) => (context.iteration === 0 ? "bump" : END),
      checkpointStore: ai.checkpoint.memory(),
      historyWindow: agentsWindow === undefined ? undefined : { agents: agentsWindow },
    });
  }

  it("passes the full history to agents when under the framework default of 15", async () => {
    let windowedCount = -1;
    const orchestrator = buildWindowed();

    await orchestrator.execute("go", {
      sessionId: "s1",
      history: HISTORY,
      on: {
        "orchestrator.history.windowed": (event) => {
          windowedCount = event.messageCount;
        },
      },
    });

    expect(windowedCount).toBe(HISTORY.length);
  });

  it("clamps the agent history to the configured per-tier window", async () => {
    let windowedCount = -1;
    const orchestrator = buildWindowed(2);

    await orchestrator.execute("go", {
      sessionId: "s1",
      history: HISTORY,
      on: {
        "orchestrator.history.windowed": (event) => {
          windowedCount = event.messageCount;
        },
      },
    });

    expect(windowedCount).toBe(2);
  });
});

describe("ai.orchestrator() — compaction (Phase 7)", () => {
  let store: CheckpointStore;

  beforeEach(() => {
    store = ai.checkpoint.memory();
  });

  function buildCompacting(options: {
    afterTurns?: number;
    onCompact?: (compaction: unknown, ctx: { sessionId: string }) => void;
  }) {
    return ai.orchestrator<CounterState, CounterState>({
      name: "compacting",
      state: { count: 0 },
      intents: {
        bump: {
          run: async () => ({ count: 1 }),
          description: "bump",
          next: () => END,
        },
      },
      route: (context) => (context.iteration === 0 ? "bump" : END),
      checkpointStore: store,
      summarize: {
        afterTurns: options.afterTurns,
        keep: 1,
        onCompact: options.onCompact,
      },
    });
  }

  it("surfaces a compaction once afterTurns is crossed and invokes onCompact", async () => {
    const onCompact = vi.fn();
    const orchestrator = buildCompacting({ afterTurns: 0, onCompact });

    const result = await orchestrator.execute("hi", {
      sessionId: "s1",
      history: HISTORY,
    });

    expect(result.compaction).toBeDefined();
    expect(result.compaction?.summary.role).toBe("system");
    expect(onCompact).toHaveBeenCalledTimes(1);

    const latest = await store.load("compacting", "s1");
    expect(latest?.summarized_through).toBe(result.compaction?.replacesToIndex);
  });

  it("does not compact when afterTurns is not reached", async () => {
    const orchestrator = buildCompacting({ afterTurns: 50 });

    const result = await orchestrator.execute("hi", {
      sessionId: "s1",
      history: HISTORY,
    });

    expect(result.compaction).toBeUndefined();
  });
});

describe("ai.orchestrator() — asTool() session scope (§13)", () => {
  function buildEcho() {
    return ai.orchestrator<CounterState, CounterState>({
      name: "echo",
      state: { count: 0 },
      intents: {
        bump: {
          run: async (context) => ({
            count: ((context.state as CounterState).count ?? 0) + 1,
            lastInput: context.input as string,
          }),
          description: "bump",
          next: () => END,
        },
      },
      route: (context) => (context.iteration === 0 ? "bump" : END),
      checkpointStore: ai.checkpoint.memory(),
    });
  }

  it('"fresh" scope (default) opens a brand-new session per invocation', async () => {
    const orchestrator = buildEcho();

    const tool = orchestrator.asTool({
      name: "echo_tool",
      description: "echoes",
      inputSchema: stringSchema,
    });

    const first = await tool.invoke("hello");
    const second = await tool.invoke("world");

    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    // Fresh scope => each invocation is turn 0 of its own session, so
    // the counter never carries past 1.
    expect((first.data as CounterState).count).toBe(1);
    expect((second.data as CounterState).count).toBe(1);
  });

  it('"shared" scope continues the same session across invocations', async () => {
    const orchestrator = buildEcho();

    const tool = orchestrator.asTool<Record<string, unknown>>({
      name: "echo_tool",
      description: "echoes",
      inputSchema: objectSchema,
      sessionScope: "shared",
    });

    await tool.invoke({ sessionId: "shared-1", message: "one" });
    const second = await tool.invoke({ sessionId: "shared-1", message: "two" });

    // Shared scope threads one sessionId, so state carries across calls.
    expect((second.data as CounterState).count).toBe(2);
  });
});

describe("ai.orchestrator() — 3-tier events fire in order (§14)", () => {
  it("emits the per-turn lifecycle events in spec order across all three tiers", async () => {
    const store = ai.checkpoint.memory();
    const definitionOrder: string[] = [];
    const instanceOrder: string[] = [];
    const perCallOrder: string[] = [];

    const orchestrator = ai.orchestrator<CounterState, CounterState>({
      name: "evented",
      state: { count: 0 },
      intents: {
        bump: {
          run: async () => ({ count: 1 }),
          description: "bump",
          next: () => END,
        },
      },
      route: (context) => (context.iteration === 0 ? "bump" : END),
      checkpointStore: store,
      on: {
        "orchestrator.turn.starting": () => definitionOrder.push("starting"),
        "orchestrator.session.loaded": () => definitionOrder.push("loaded"),
        "orchestrator.drift.checked": () => definitionOrder.push("drift"),
        "orchestrator.history.windowed": () => definitionOrder.push("windowed"),
        "orchestrator.turn.routed": () => definitionOrder.push("routed"),
        "orchestrator.checkpoint.persisted": () =>
          definitionOrder.push("persisted"),
        // A clean turn settles on the non-terminal `awaiting-input`
        // status (§15.6) — that, not `completed`, is the terminal it fires.
        "orchestrator.turn.awaiting-input": () =>
          definitionOrder.push("awaiting-input"),
      },
    });

    // tier 2 — instance subscription.
    orchestrator.on("orchestrator.turn.starting", () =>
      instanceOrder.push("starting"),
    );
    orchestrator.on("orchestrator.checkpoint.persisted", () =>
      instanceOrder.push("persisted"),
    );

    await orchestrator.execute("hi", {
      sessionId: "s1",
      history: HISTORY,
      // tier 3 — per-call subscription.
      on: {
        "orchestrator.turn.starting": () => perCallOrder.push("starting"),
        "orchestrator.turn.awaiting-input": () =>
          perCallOrder.push("awaiting-input"),
      },
    });

    expect(definitionOrder).toEqual([
      "starting",
      "loaded",
      "drift",
      "windowed",
      "routed",
      "persisted",
      "awaiting-input",
    ]);
    expect(instanceOrder).toEqual(["starting", "persisted"]);
    expect(perCallOrder).toEqual(["starting", "awaiting-input"]);
  });

  it("fires definition, instance, and per-call handlers in tier order for one event", async () => {
    const tierOrder: string[] = [];

    const orchestrator = ai.orchestrator<CounterState, CounterState>({
      name: "tiered",
      state: { count: 0 },
      intents: {
        bump: {
          run: async () => ({ count: 1 }),
          description: "bump",
          next: () => END,
        },
      },
      route: (context) => (context.iteration === 0 ? "bump" : END),
      checkpointStore: ai.checkpoint.memory(),
      on: {
        "orchestrator.turn.starting": () => tierOrder.push("definition"),
      },
    });

    orchestrator.on("orchestrator.turn.starting", () =>
      tierOrder.push("instance"),
    );

    await orchestrator.execute("hi", {
      sessionId: "s1",
      history: [],
      on: {
        "orchestrator.turn.starting": () => tierOrder.push("per-call"),
      },
    });

    expect(tierOrder).toEqual(["definition", "instance", "per-call"]);
  });
});

describe("ai.orchestrator() — stream() yields events and resolves the result", () => {
  it("yields the turn's lifecycle events and resolves the same OrchestratorResult", async () => {
    const orchestrator = buildCounter(ai.checkpoint.memory());

    const stream = orchestrator.stream("hello", {
      sessionId: "s1",
      history: HISTORY,
    });

    const eventTypes: OrchestratorEvent["type"][] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }

    const result: OrchestratorResult<CounterState> = await stream.result;

    expect(eventTypes).toContain("orchestrator.turn.starting");
    expect(eventTypes).toContain("orchestrator.checkpoint.persisted");
    // A clean turn settles on the non-terminal `awaiting-input` status
    // (§15.6) — that terminal fires, not `completed`.
    expect(eventTypes).toContain("orchestrator.turn.awaiting-input");

    expect(result.error).toBeUndefined();
    expect(result.sessionId).toBe("s1");
    expect(result.turnIndex).toBe(0);
    expect((result.data as CounterState).count).toBe(1);
  });

  it("routes streamed events to handlers registered via stream.on()", async () => {
    const orchestrator = buildCounter(ai.checkpoint.memory());
    const seen: string[] = [];

    const stream = orchestrator.stream("hello", {
      sessionId: "s1",
      history: [],
    });

    stream.on({
      "orchestrator.turn.starting": () => seen.push("starting"),
      "orchestrator.checkpoint.persisted": () => seen.push("persisted"),
    });

    await stream.result;

    expect(seen).toContain("starting");
    expect(seen).toContain("persisted");
  });
});

describe("ai.orchestrator() — exactly one terminal event per turn (§14.1)", () => {
  /**
   * Subscribe to all four terminal events and tally each emission so a
   * test can assert precisely one terminal fires per turn — the fall-
   * through that double-fired `awaiting-input` + `completed` on a clean
   * turn must not regress.
   */
  function tallyTerminals(
    on: (terminals: string[]) => void,
  ): {
    "orchestrator.turn.completed": () => void;
    "orchestrator.turn.failed": () => void;
    "orchestrator.turn.cancelled": () => void;
    "orchestrator.turn.awaiting-input": () => void;
  } {
    const terminals: string[] = [];
    on(terminals);

    return {
      "orchestrator.turn.completed": () => terminals.push("completed"),
      "orchestrator.turn.failed": () => terminals.push("failed"),
      "orchestrator.turn.cancelled": () => terminals.push("cancelled"),
      "orchestrator.turn.awaiting-input": () =>
        terminals.push("awaiting-input"),
    };
  }

  it("fires only awaiting-input on a clean turn (no double-fire)", async () => {
    let terminals: string[] = [];
    const orchestrator = buildCounter(ai.checkpoint.memory());

    await orchestrator.execute("go", {
      sessionId: "s1",
      history: [],
      on: tallyTerminals((captured) => {
        terminals = captured;
      }),
    });

    expect(terminals).toEqual(["awaiting-input"]);
  });

  it("fires only turn.cancelled on a cancelled turn", async () => {
    let terminals: string[] = [];
    const controller = new AbortController();
    controller.abort("stop");

    const orchestrator = buildCounter(ai.checkpoint.memory());

    const result = await orchestrator.execute("go", {
      sessionId: "s1",
      history: [],
      signal: controller.signal,
      on: tallyTerminals((captured) => {
        terminals = captured;
      }),
    });

    expect(result.report.status).toBe("cancelled");
    expect(terminals).toEqual(["cancelled"]);
  });

  it("fires only turn.failed on a failed turn", async () => {
    let terminals: string[] = [];

    const orchestrator = ai.orchestrator<CounterState, CounterState>({
      name: "boom",
      state: { count: 0 },
      intents: {
        boom: {
          run: async () => {
            throw new Error("intent blew up");
          },
          description: "always throws",
          next: () => END,
        },
      },
      route: (context) => (context.iteration === 0 ? "boom" : END),
      checkpointStore: ai.checkpoint.memory(),
    });

    const result = await orchestrator.execute("go", {
      sessionId: "s1",
      history: [],
      on: tallyTerminals((captured) => {
        terminals = captured;
      }),
    });

    expect(result.error).toBeDefined();
    // Both `failed` and `max-iterations` are non-clean terminals that map
    // to the single `turn.failed` emission (§14.1); the exhausted retry
    // loop here surfaces `max-iterations`.
    expect(["failed", "max-iterations"]).toContain(result.report.status);
    expect(terminals).toEqual(["failed"]);
  });
});
