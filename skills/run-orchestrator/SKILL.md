---
name: run-orchestrator
description: 'Durable stateful sessions with ai.orchestrator({...}) — the capstone of the 4-primitive ladder. Wraps a supervisor with cross-turn session state (checkpointStore), per-turn windowing, drift detection, post-turn compaction, mid-turn resume (iterate: true + snapshotStore), per-turn memory, typed commands, asTool, and a 3-tier event model. Triggers: `ai.orchestrator`, `orchestrator.execute`, `orchestrator.resume`, `orchestrator.command`, `orchestrator.stream`, `OrchestratorConfig`, `OrchestratorResult`, `OrchestratorReport`, `OrchestratorContract`, `CheckpointStore`, `OrchestratorDriftError`, `sessionId`, `iterate`, `historyWindow`, `summarize`, `keepSnapshots`, `awaiting-input`, `turns[]`, `TurnSnapshot`, `CompactionResult`, `initialAgent`, `checkpointStore`; ''multi-turn conversation that persists'', ''durable session across calls'', ''resume an interrupted turn'', ''compact session history'', ''per-session memory''; typical import `import { ai } from "@warlock.js/ai"`. Skip: a single routing turn with no session — `@warlock.js/ai/run-supervisor/SKILL.md`; a fixed pipeline — `@warlock.js/ai/run-ai-workflow/SKILL.md`; the store factories themselves — `@warlock.js/ai/manage-ai-stores/SKILL.md`; competing libs `langgraph`, `crewai`.'
---

# `ai.orchestrator()` — durable stateful sessions

The capstone of the 4-primitive ladder. An orchestrator is a **session-state manager wrapped around a supervisor**: each `execute` / `stream` call is ONE turn against a named `sessionId`, with the session's accumulated state, drift signature, and compaction progress persisted in a `CheckpointStore` between calls. The "what runs" fields (`intents`, `route` / `router`, `evaluate`, `state`, `output`, `initialAgent`, `maxIterations`) are the supervisor's surface spread directly — the orchestrator builds the supervisor lazily per turn and delegates to it. You never see the supervisor object.

## When to reach for it

- **`supervisor`** — routes one input to a specialist each turn; stateless between runs unless you wire `snapshotStore`. No cross-turn session memory.
- **`orchestrator`** — when the **session** matters: a long-running conversation where each turn must rehydrate the prior turn's state, history must be windowed/compacted, and an interrupted turn must resume after a crash.

## Shape

```ts
import { ai } from "@warlock.js/ai";
import { END } from "@warlock.js/ai";

type SessionState = { category?: string; order?: { id: string }; reply?: string };

const supportBot = ai.orchestrator<SessionState>({
  name: "refund-support",
  intents: { classify, lookup, process, compose },
  route: (ctx) => (ctx.iteration === 0 ? "classify" : END),
  iterate: true,                                  // delegate each turn to a real supervisor
  historyWindow: { router: 5, agents: 20 },
  summarize: { afterTurns: 20, keep: 6 },         // auto-compaction policy
  keepSnapshots: 100,                             // turns retained per session
  checkpointStore: ai.checkpoint.pg({ client: pg }),
  snapshotStore: ai.snapshot.pg({ client: pg }),  // required when iterate: true
});

const result = await supportBot.execute(message, { sessionId: "sess_42", history });

if (result.report.status === "awaiting-input") {
  // session continues — wait for the next user turn
}
```

`route` XOR `router` is required (mutually exclusive). `initialAgent`, when set, must be a key in `intents` and dispatches on turn 0, skipping the first route/router call. All config-shape errors throw `OrchestratorConfigError` at construction (author-time), not on the first turn.

## The session is owned by `sessionId` — passed per call

There is no stateful session object and no implicit "current session" — every method names the session it acts on via `options.sessionId`. `history` is **required** on every `execute` call: the framework never persists raw messages (it owns session *state*, not the message log — that is the dev's store). `state` is a partial seed/patch shallow-merged into the loaded session state; `context` is the request-scoped bag, frozen at intake.

```ts
await supportBot.execute(input, {
  sessionId: "sess_42",       // required — names the session
  history: priorMessages,     // required — the dev re-supplies prior turns each call
  state: { tier: "gold" },    // partial patch shallow-merged into loaded state
  context: { userId, db },    // request-scoped, never persisted
  signal: AbortSignal.timeout(60_000),
  on: { "orchestrator.turn.awaiting-input": (e) => log(e) },  // tier-3 per-call handlers
  force: false,               // bypass drift check for this call
});
```

## The turn lifecycle (what each turn does)

1. **load** — read the latest checkpoint for `(name, sessionId)`; seed empty on first call (`orchestrator.session.loaded`).
2. **drift check** — compare the loaded checkpoint's `signature` to the current definition (`orchestrator.drift.checked`). Mismatch throws `OrchestratorDriftError` unless `force: true`.
3. **lock wait** — wait on the compaction lock if held (`orchestrator.lock.waiting`).
4. **window** — slice history per `historyWindow.{router,agents}` (`orchestrator.history.windowed`).
5. **dispatch** — `route`/`router` (or `initialAgent` on turn 0) picks the intent(s); the supervisor runs the turn (`orchestrator.turn.routed`, `orchestrator.turn.streaming`).
6. **persist** — append a checkpoint row for the settled turn, then prune to `keepSnapshots` (`orchestrator.checkpoint.persisted`).
7. **compaction** — fire the post-turn compaction trigger if configured (`orchestrator.compaction.suggested` / `.applied`).

A clean turn ends with `orchestrator.turn.awaiting-input` (the session stays open for the next user turn); `orchestrator.turn.failed` and `orchestrator.turn.cancelled` end error / cancelled turns. (`orchestrator.turn.completed` is defined on the event map, but the v1 lifecycle maps a clean completion to `awaiting-input`, so it isn't emitted on the normal path — subscribe to `awaiting-input` for "turn done".)

## `OrchestratorResult` — read the report

```ts
const result = await supportBot.execute(message, { sessionId, history });

result.sessionId;                 // echoes the session this turn acted on
result.turnIndex;                 // zero-indexed turn number
result.data;                      // validated against `output`, if set
result.error;                     // typed AIError — execute() never throws on runtime failure
result.report.type;               // "orchestrator"
result.report.status;             // ReportStatus | "awaiting-input"
result.report.turns;              // TurnSnapshot[] — current turn + prior, bounded by keepSnapshots
result.compaction;                // CompactionResult when a turn compacted (and no onCompact ran)
```

`report.children[]` carries ONLY the current turn's dispatched primitive reports. Full session history lives on `report.turns[]` — a `children[]` walker will NOT reach prior turns (intentional). Child `supervisor.*` / `agent.*` events bubble up unmodified under their own identity.

**`awaiting-input` is the only non-terminal status across the unified result tree.** Code branching on `status === "completed"` MUST explicitly handle `"awaiting-input"` as a session-continues path, not a failure.

## `iterate` — single dispatch vs. internal supervisor

- **`iterate: false`** (default) — one dispatch per turn. No `snapshotStore` needed.
- **`iterate: true`** — each turn delegates to a real internal supervisor that loops to `maxIterations` (default 10). **Requires** a `snapshotStore` (explicit or `ai.config({ defaultSnapshotStore })`) so a crashed mid-turn iteration can resume. Construction throws if you set `iterate: true` without one.

## `resume()` — drain an interrupted turn

```ts
const result = await supportBot.resume("sess_42", { context: { db }, force: false });
```

Resume continues an interrupted `iterate: true` turn from its persisted supervisor snapshot. Returns `null` when there is nothing in flight for the session (a no-op for `iterate: false` orchestrators). It re-supplies request-scoped `context` (NOT persisted) and rehydrates state from the checkpoint — there is no `history` field, since it continues an in-flight turn rather than opening a fresh one. Runs the same drift check as `execute()`; throws `OrchestratorDriftError` on mismatch unless `{ force: true }`. Use the boot-drain pattern: enumerate sessions via `checkpointStore.list(name)` and `resume()` each on startup.

## Compaction — `summarize`

Bounds session history growth. Two forms:

```ts
// Object policy — count-based auto-fire after `afterTurns`, keep the most recent `keep`.
summarize: {
  afterTurns: 20,
  keep: 6,
  summarizer: cheapModel,                  // defaults to the orchestrator's own model
  onCompact: async (compaction, ctx) => {  // apply to the dev's message store
    await messages.applyCompaction(ctx.sessionId, compaction);
  },
  lock: { maxWait: 5_000 },
}

// Callback form — full control; NEVER auto-fires, driven only by command("compact").
summarize: (history) => ({ summary, replacesFromIndex, replacesToIndex }),
```

A `CompactionResult` is `{ summary: Message, replacesFromIndex, replacesToIndex }` — the replacement summary plus the inclusive index range it replaces in the dev's history array. When `onCompact` is supplied the orchestrator applies it for you and does NOT surface `result.compaction`; otherwise it surfaces `result.compaction` for you to apply manually.

## `command()` — typed built-ins

```ts
const compaction = await supportBot.command("compact", { sessionId, history });
// → { summary, replacesFromIndex, replacesToIndex }
```

v1 ships exactly one built-in command, `compact` (manual compaction outside the auto-trigger; reuses the same compaction code path). User commands attach via module augmentation of `OrchestratorCommands` — declaring extra keys in your own `.d.ts` widens the typed `command<K>` surface without a framework release.

## Per-turn memory — `memory`

Wire an `ai.memory()` store so each turn recalls relevant memories before routing and remembers the settled outcome after:

```ts
ai.orchestrator({
  name: "support",
  intents,
  route,
  memory: mem,                                  // bare MemoryContract — recall + remember w/ defaults
  // or finer control:
  memory: {
    store: mem,
    recall: { k: 5, threshold: 0.7, tier: "semantic" },  // k: 0 = write-only memory
    remember: true,                             // false = read-only (recall, never write)
    rememberTier: "semantic",
    injectKey: "memories",                      // ctx.context[injectKey] holds RecalledMemory[]
  },
});
```

Recalled memories land in the per-turn `context` bag under `injectKey` (default `"memories"`) — every route / router / evaluate / dispatch callback reads them at `ctx.context.memories`. Memory never mutates the prompt itself; surfacing it stays explicit. Cancelled / failed turns never remember (they revert), regardless of `remember`. See [`@warlock.js/ai/use-ai-memory/SKILL.md`](@warlock.js/ai/use-ai-memory/SKILL.md).

## `asTool()` — orchestrator as a tool

```ts
const supportTool = supportBot.asTool({
  name: "handle_refund",
  description: "Handle a refund conversation end-to-end.",
  inputSchema: v.object({ message: v.string() }),
  sessionScope: "fresh",   // default — each call gets a brand-new sessionId
});

const concierge = ai.agent({ model, tools: [supportTool] });
```

The tool boundary is **opaque**: the parent's `signal` / `context` / events do NOT auto-forward — anything the wrapped orchestrator needs must ride on the `inputSchema` payload. `sessionScope`:
- **`"fresh"`** (default) — each invocation gets a generated `sessionId` and empty history; no continuity across calls.
- **`"shared"`** — the parent threads `sessionId` (and optionally `history`) through the validated payload; the orchestrator participates in that session. A missing/blank `sessionId` throws.

## Drift detection

The orchestrator signature fingerprints: name + intents map + route/router presence + evaluate presence + initialAgent + maxIterations + iterate flag + historyWindow shape. It does NOT aggregate the internal supervisor's signature — internal-supervisor drift surfaces only on `iterate: true` resume via the supervisor's own drift check. On mismatch, `OrchestratorDriftError` (`code: "ORCHESTRATOR_DRIFT"`, `category: "drift"`) is thrown synchronously — nothing dispatches. Recover by discarding the session, migrating the persisted checkpoint, or passing `{ force: true }`.

## 3-tier events

Handlers fire definition → instance → per-call, in that order, on every emission:

```ts
const orch = ai.orchestrator({ ..., on: { "orchestrator.turn.failed": tier1 } });   // tier 1 — definition
const off = orch.on("orchestrator.turn.completed", tier2);                          // tier 2 — instance
await orch.execute(input, { sessionId, history, on: { "orchestrator.drift.checked": tier3 } }); // tier 3 — per-call
```

## Stores

`checkpointStore` (cross-turn session state) and `snapshotStore` (internal-supervisor run state for `iterate: true`) are distinct contracts with distinct factories. See [`@warlock.js/ai/manage-ai-stores/SKILL.md`](@warlock.js/ai/manage-ai-stores/SKILL.md).

## See also

- [`@warlock.js/ai/run-supervisor/SKILL.md`](@warlock.js/ai/run-supervisor/SKILL.md) — the engine each turn delegates to
- [`@warlock.js/ai/manage-ai-stores/SKILL.md`](@warlock.js/ai/manage-ai-stores/SKILL.md) — `ai.checkpoint.*` / `ai.snapshot.*`
- [`@warlock.js/ai/use-ai-memory/SKILL.md`](@warlock.js/ai/use-ai-memory/SKILL.md) — the `memory` field
- [`@warlock.js/ai/handle-ai-errors/SKILL.md`](@warlock.js/ai/handle-ai-errors/SKILL.md) — `OrchestratorDriftError` / `OrchestratorConfigError`
