import { describe, expect, it } from "vitest";
import { ai } from "../ai";
import type { RecalledMemory } from "../contracts/memory/memory-item.type";
import type { CheckpointStore } from "../contracts/orchestrator/checkpoint-store.contract";
import { END } from "../contracts/end.type";
import { memory } from "../memory";

/**
 * Memory-orchestrator integration suite (memory core M2). Drives the real
 * `ai.orchestrator(...)` factory → engine path with an attached
 * `ai.memory(...)` store against the in-memory checkpoint store — no
 * network, no real LLM. Asserts the M2 contract a downstream dev sees:
 *
 * - recalled memories are injected into `ctx.context[injectKey]` BEFORE
 *   dispatch so an intent reads prior context for the current turn;
 * - the settled turn outcome is remembered afterward so a later turn
 *   recalls it;
 * - the existing no-memory behavior is unchanged (additive);
 * - the per-turn config knobs (`injectKey`, `recall.k`, `remember`)
 *   behave as documented.
 *
 * The intent under test is a callback that captures whatever it sees on
 * `ctx.context` so a test can read back exactly what the lifecycle
 * injected — the seam M2 added.
 */

type SeenState = {
  /** The recalled memories the intent observed on its dispatch context. */
  seen?: RecalledMemory[];
  /** The raw value at the inject key, for the "unchanged when no memory" case. */
  rawInjectKey?: unknown;
  echo?: string;
};

/**
 * Build an `iterate: false` orchestrator whose single `respond` intent
 * captures the recalled memories from `ctx.context[injectKey]` into
 * session state and echoes a canned answer. `injectKey` defaults to
 * `"memories"`; the suite overrides it to exercise the knob.
 */
function buildMemoryBot(
  checkpointStore: CheckpointStore,
  memoryConfig: NonNullable<
    Parameters<typeof ai.orchestrator>[0]
  >["memory"],
  injectKey = "memories",
  answer = "the answer",
) {
  return ai.orchestrator<SeenState, SeenState>({
    name: "memory-bot",
    state: {},
    intents: {
      respond: {
        run: async (context) => ({
          seen: context.context[injectKey] as RecalledMemory[] | undefined,
          rawInjectKey: context.context[injectKey],
          echo: answer,
        }),
        description: "Echo a canned answer, capturing recalled memories",
        next: () => END,
      },
    },
    route: (context) => (context.iteration === 0 ? "respond" : END),
    checkpointStore,
    memory: memoryConfig,
  });
}

describe("ai.orchestrator() — memory recall injection (M2)", () => {
  it("injects pre-seeded recalled memories into ctx.context before dispatch", async () => {
    const store = ai.checkpoint.memory();
    const mem = memory();

    // Seed a prior memory the upcoming turn should recall.
    await mem.remember({ text: "the user prefers metric units" });

    const bot = buildMemoryBot(store, mem);

    const result = await bot.execute("what units?", {
      sessionId: "s1",
      history: [],
    });

    const seen = (result.report.turns[0]?.state as SeenState).seen;

    expect(result.error).toBeUndefined();
    expect(seen).toBeDefined();
    expect(seen?.some((hit) => hit.text === "the user prefers metric units")).toBe(
      true,
    );
  });

  it("recalls a memory a PRIOR turn remembered, on a later turn", async () => {
    const store = ai.checkpoint.memory();
    const mem = memory();

    const bot = buildMemoryBot(store, mem);

    // Turn 0 — nothing to recall yet; the lifecycle remembers the outcome.
    const first = await bot.execute("remember the launch is in March", {
      sessionId: "s1",
      history: [],
    });

    expect((first.report.turns[0]?.state as SeenState).seen ?? []).toHaveLength(0);

    // Turn 1 — the prior turn's remembered outcome is recalled + injected.
    const second = await bot.execute("when is the launch?", {
      sessionId: "s1",
      history: [],
    });

    const seen = (second.report.turns[0]?.state as SeenState).seen ?? [];

    expect(seen.length).toBeGreaterThan(0);
    expect(
      seen.some((hit) => hit.text.includes("the launch is in March")),
    ).toBe(true);
  });

  it("accepts the bare MemoryContract form and remembers the turn outcome", async () => {
    const store = ai.checkpoint.memory();
    const mem = memory();

    const bot = buildMemoryBot(store, mem);

    await bot.execute("first turn input", { sessionId: "s1", history: [] });

    // The lifecycle wrote the turn outcome back into memory.
    const recalled = await mem.recall("first turn input");

    expect(recalled.some((hit) => hit.text.includes("first turn input"))).toBe(
      true,
    );
  });
});

describe("ai.orchestrator() — memory config knobs (M2)", () => {
  it("honors a custom injectKey", async () => {
    const store = ai.checkpoint.memory();
    const mem = memory();

    await mem.remember({ text: "custom-key memory" });

    const bot = buildMemoryBot(store, { store: mem, injectKey: "recall" }, "recall");

    const result = await bot.execute("query", { sessionId: "s1", history: [] });

    const seen = (result.report.turns[0]?.state as SeenState).seen;

    expect(seen?.some((hit) => hit.text === "custom-key memory")).toBe(true);
  });

  it("skips recall when recall.k is 0 (write-only memory)", async () => {
    const store = ai.checkpoint.memory();
    const mem = memory();

    await mem.remember({ text: "should not be recalled" });

    const bot = buildMemoryBot(store, { store: mem, recall: { k: 0 } });

    const result = await bot.execute("query", { sessionId: "s1", history: [] });

    const seen = (result.report.turns[0]?.state as SeenState).seen ?? [];

    // Nothing injected — but the turn outcome is still remembered.
    expect(seen).toHaveLength(0);

    const recalled = await mem.recall("query");
    expect(recalled.some((hit) => hit.text.includes("query"))).toBe(true);
  });

  it("does not remember the outcome when remember is false (read-only memory)", async () => {
    const store = ai.checkpoint.memory();
    const mem = memory();

    await mem.remember({ text: "seeded read-only memory" });

    const bot = buildMemoryBot(store, { store: mem, remember: false });

    // Recall still works on turn 0.
    const result = await bot.execute("the brand new query text", {
      sessionId: "s1",
      history: [],
    });

    expect(
      (result.report.turns[0]?.state as SeenState).seen?.some(
        (hit) => hit.text === "seeded read-only memory",
      ),
    ).toBe(true);

    // ...but the turn outcome was NOT written back.
    const recalled = await mem.recall("the brand new query text");
    expect(
      recalled.some((hit) => hit.text.includes("the brand new query text")),
    ).toBe(false);
  });
});

describe("ai.orchestrator() — without memory (unchanged)", () => {
  it("leaves ctx.context free of an injected memories key", async () => {
    const store = ai.checkpoint.memory();

    const bot = buildMemoryBot(store, undefined);

    const result = await bot.execute("plain", { sessionId: "s1", history: [] });

    expect(result.error).toBeUndefined();
    expect(
      (result.report.turns[0]?.state as SeenState).rawInjectKey,
    ).toBeUndefined();
  });
});
