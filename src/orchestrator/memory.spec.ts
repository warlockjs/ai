import { describe, expect, it } from "vitest";
import { ai } from "../ai";
import type { RecalledMemory } from "../contracts/memory/memory-item.type";
import type { CheckpointStore } from "../contracts/orchestrator/checkpoint-store.contract";
import { END } from "../contracts/end.type";
import { memory } from "../memory";
import { sessionMemoryScope } from "./memory";

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

    // Seed a prior memory the upcoming turn should recall. Memory is
    // session-scoped by default (4.15.0), so the seed must name the
    // session that will read it.
    await mem.remember({
      text: "the user prefers metric units",
      scope: sessionMemoryScope("s1"),
    });

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

    // The lifecycle wrote the turn outcome back into memory, under the
    // executing session's scope.
    const recalled = await mem.recall("first turn input", {
      scope: sessionMemoryScope("s1"),
    });

    expect(recalled.some((hit) => hit.text.includes("first turn input"))).toBe(
      true,
    );
  });
});

describe("ai.orchestrator() — memory config knobs (M2)", () => {
  it("honors a custom injectKey", async () => {
    const store = ai.checkpoint.memory();
    const mem = memory();

    await mem.remember({
      text: "custom-key memory",
      scope: sessionMemoryScope("s1"),
    });

    const bot = buildMemoryBot(store, { store: mem, injectKey: "recall" }, "recall");

    const result = await bot.execute("query", { sessionId: "s1", history: [] });

    const seen = (result.report.turns[0]?.state as SeenState).seen;

    expect(seen?.some((hit) => hit.text === "custom-key memory")).toBe(true);
  });

  it("skips recall when recall.k is 0 (write-only memory)", async () => {
    const store = ai.checkpoint.memory();
    const mem = memory();

    await mem.remember({
      text: "should not be recalled",
      scope: sessionMemoryScope("s1"),
    });

    const bot = buildMemoryBot(store, { store: mem, recall: { k: 0 } });

    const result = await bot.execute("query", { sessionId: "s1", history: [] });

    const seen = (result.report.turns[0]?.state as SeenState).seen ?? [];

    // Nothing injected — but the turn outcome is still remembered.
    expect(seen).toHaveLength(0);

    const recalled = await mem.recall("query", {
      scope: sessionMemoryScope("s1"),
    });
    expect(recalled.some((hit) => hit.text.includes("query"))).toBe(true);
  });

  it("does not remember the outcome when remember is false (read-only memory)", async () => {
    const store = ai.checkpoint.memory();
    const mem = memory();

    await mem.remember({
      text: "seeded read-only memory",
      scope: sessionMemoryScope("s1"),
    });

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
    const recalled = await mem.recall("the brand new query text", {
      scope: sessionMemoryScope("s1"),
    });
    expect(
      recalled.some((hit) => hit.text.includes("the brand new query text")),
    ).toBe(false);
  });
});

/**
 * Session-isolation regression suite for the 4.15.0 security fix
 * (audit HIGH — "memory has no session or tenant isolation").
 *
 * One `ai.memory()` is resolved once per orchestrator instance and reused
 * by every session, which is the documented integration pattern. Before
 * the fix, that meant user B's turn recalled user A's remembered text.
 * The scope key — derived from the execute-time `sessionId`, never from
 * the payload or the model — is what makes that impossible now.
 */
describe("ai.orchestrator() — memory session isolation (security)", () => {
  it("does not recall another session's remembered turn (default scope)", async () => {
    const store = ai.checkpoint.memory();
    const mem = memory();

    const bot = buildMemoryBot(store, mem);

    // Session A tells the bot something private; the turn outcome is
    // remembered automatically (remember defaults to true).
    await bot.execute("my account email is a@example.com", {
      sessionId: "session-a",
      history: [],
    });

    // Session B asks a semantically identical question.
    const bTurn = await bot.execute("my account email is a@example.com", {
      sessionId: "session-b",
      history: [],
    });

    const seen = (bTurn.report.turns[0]?.state as SeenState).seen ?? [];

    expect(seen).toHaveLength(0);
    expect(seen.some((hit) => hit.text.includes("a@example.com"))).toBe(false);

    // Session A still recalls its own memory on its next turn.
    const aTurn = await bot.execute("my account email is a@example.com", {
      sessionId: "session-a",
      history: [],
    });

    expect(
      ((aTurn.report.turns[0]?.state as SeenState).seen ?? []).some((hit) =>
        hit.text.includes("a@example.com"),
      ),
    ).toBe(true);
  });

  it("keeps a session's write out of the unscoped/global pool", async () => {
    const store = ai.checkpoint.memory();
    const mem = memory();

    const bot = buildMemoryBot(store, mem);

    await bot.execute("private to session a", {
      sessionId: "session-a",
      history: [],
    });

    // An unscoped recall (the shared pool) sees nothing the session wrote.
    expect(await mem.recall("private to session a")).toHaveLength(0);

    // ...and the session's own scope does.
    expect(
      await mem.recall("private to session a", {
        scope: sessionMemoryScope("session-a"),
      }),
    ).not.toHaveLength(0);
  });

  it('scope: "shared" is the explicit opt-in back to cross-session pooling', async () => {
    const store = ai.checkpoint.memory();
    const mem = memory();

    const bot = buildMemoryBot(store, { store: mem, scope: "shared" });

    await bot.execute("the launch is in March", {
      sessionId: "session-a",
      history: [],
    });

    const bTurn = await bot.execute("when is the launch?", {
      sessionId: "session-b",
      history: [],
    });

    const seen = (bTurn.report.turns[0]?.state as SeenState).seen ?? [];

    expect(seen.some((hit) => hit.text.includes("the launch is in March"))).toBe(
      true,
    );
  });

  it("a scope callback isolates tenants while sharing within one tenant", async () => {
    const store = ai.checkpoint.memory();
    const mem = memory();

    // "acme:<user>" / "globex:<user>" → tenant-level pooling.
    const bot = buildMemoryBot(store, {
      store: mem,
      scope: (sessionId) => sessionId.split(":")[0],
    });

    await bot.execute("the acme contract renews in June", {
      sessionId: "acme:user-1",
      history: [],
    });

    // Same tenant, different user → shared.
    const sameTenant = await bot.execute("when does the contract renew?", {
      sessionId: "acme:user-2",
      history: [],
    });

    expect(
      ((sameTenant.report.turns[0]?.state as SeenState).seen ?? []).some((hit) =>
        hit.text.includes("the acme contract renews in June"),
      ),
    ).toBe(true);

    // Different tenant → isolated.
    const otherTenant = await bot.execute("when does the contract renew?", {
      sessionId: "globex:user-1",
      history: [],
    });

    expect(
      ((otherTenant.report.turns[0]?.state as SeenState).seen ?? []).some((hit) =>
        hit.text.includes("the acme contract renews in June"),
      ),
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
