import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { FlowObserveOption } from "../../observe/resolve-observers";
import type { AgentContract } from "../agent/agent.contract";
import type { Message } from "../conversation-message.type";
import type { MemoryTier } from "../memory/memory-item.type";
import type { MemoryContract } from "../memory/memory.contract";
import type { ModelContract } from "../model.contract";
import type { CompactionResult } from "../result/orchestrator-result.type";
import type { EvaluateContext, EvaluateResult } from "../supervisor/evaluate-context.type";
import type { SupervisorIntentValue } from "../supervisor/intent-entry.type";
import type { Next } from "../supervisor/next.type";
import type { RouteContext } from "../supervisor/route-context.type";
import type { RouterEntry } from "../supervisor/router-entry.type";
import type { SystemPromptContract } from "../system-prompt.contract";
import type { CheckpointStore } from "./checkpoint-store.contract";
import type { OrchestratorEventHandlers } from "./orchestrator-event.type";
import type { SessionLock } from "./session-lock.contract";
import type { SnapshotStore } from "./snapshot-store.contract";

/**
 * Object form of `OrchestratorConfig.summarize` (design §12.4) — the
 * automatic post-turn compaction policy. Fires after `afterTurns`,
 * keeps the most recent `keep` messages, and summarizes the rest with
 * `summarizer`. `onCompact` lets the dev apply the produced summary to
 * their own message store; `lock` bounds how long a turn waits on the
 * compaction lock before failing open.
 */
export type SummarizeConfig = {
  /** Trigger compaction once the turn count crosses this threshold. */
  afterTurns?: number;
  /** Number of most-recent messages to keep verbatim (not summarized). Default 8. */
  keep?: number;
  /** Model used to produce the summary. Defaults to the orchestrator's own model. */
  summarizer?: ModelContract;
  /**
   * Applies the produced compaction to the dev's message store. When
   * supplied the orchestrator does not surface `result.compaction` for
   * the dev to apply manually.
   */
  onCompact?: (
    compaction: CompactionResult,
    ctx: { sessionId: string },
  ) => Promise<void> | void;
  /** Compaction-lock tuning. `maxWait` caps the per-turn wait in ms. */
  lock?: { maxWait?: number };
};

/**
 * Callback form of `OrchestratorConfig.summarize` (design §12.4). Full
 * control: receives the session history, returns the compaction result
 * directly. Use when the built-in `SummarizeConfig` policy is too
 * coarse.
 */
export type SummarizeCallback = (
  history: Message[],
) => Promise<CompactionResult> | CompactionResult;

/**
 * Per-turn memory wiring for `OrchestratorConfig.memory` (memory core
 * M2). The `store` is the {@link MemoryContract} the orchestrator
 * recalls from before each dispatch and remembers into after each turn
 * settles. `recall` tunes the pre-dispatch recall (how many memories,
 * the similarity floor, an optional single-tier restriction); `remember`
 * toggles whether the turn outcome is written back. When `recall.k` is 0
 * the orchestrator skips recall entirely (write-only memory); when
 * `remember` is `false` it recalls but never writes (read-only memory).
 *
 * The recalled memories are injected into the request-scoped `context`
 * bag under the `injectKey` (default `"memories"`) so every route /
 * router / evaluate / dispatch callback reads them at
 * `ctx.context[injectKey]` — memory never mutates the prompt itself, the
 * surfacing point stays explicit (the same contract `MemoryContract`
 * documents).
 */
export type OrchestratorMemoryConfig = {
  /** The memory store recalled-from before dispatch and remembered-into after. */
  store: MemoryContract;
  /**
   * Pre-dispatch recall tuning. `k` caps the injected count (0 disables
   * recall — write-only memory); `threshold` raises the semantic
   * similarity floor; `tier` restricts recall to a single tier. Omit for
   * the memory's own configured defaults.
   */
  recall?: {
    k?: number;
    threshold?: number;
    tier?: MemoryTier;
  };
  /**
   * Write the settled turn outcome back into memory after a clean turn.
   * Default `true`. Set `false` for a read-only memory that recalls but
   * never accumulates. Cancelled / failed turns never remember (they
   * revert — §17), regardless of this flag.
   */
  remember?: boolean;
  /**
   * Tier the remembered turn outcome lands in. Omit to use the memory's
   * own `defaultTier`. Pass `"semantic"` to durably accumulate turns for
   * later cross-session recall.
   */
  rememberTier?: MemoryTier;
  /**
   * Key the recalled memories are injected under inside the per-turn
   * `context` bag. Callbacks read them at `ctx.context[injectKey]` as a
   * `RecalledMemory[]`. Default `"memories"`.
   */
  injectKey?: string;
};

/**
 * Factory config for `ai.orchestrator(config)` (design §15.2).
 *
 * The "what runs" fields (`intents`, `route` / `router`, `evaluate`,
 * `state`, `output`, `initialAgent`, `maxIterations`) are the
 * supervisor's surface spread directly — the orchestrator builds the
 * supervisor lazily per turn and delegates to it. The remaining fields
 * are orchestrator-specific: session-scoped history windowing,
 * compaction, snapshot retention, and the two durable stores.
 *
 * `TState` defaults to `TOutput` for the common case where the working
 * session state IS the output shape. `TIntents` captures the literal
 * intent map so `ctx.intents.<TAB>` autocompletes against real keys.
 *
 * @example
 * const supportBot = ai.orchestrator<SessionState>({
 *   name: "refund-support",
 *   intents: { classify, lookup, process, compose },
 *   route: (ctx) => (ctx.iteration === 0 ? "classify" : END),
 *   iterate: true,
 *   historyWindow: { router: 5, agents: 20 },
 *   checkpointStore: ai.checkpoint.pg({ client: pg }),
 *   snapshotStore: ai.snapshot.pg({ client: pg }),
 * });
 */
export type OrchestratorConfig<
  TOutput,
  TState = TOutput,
  TIntents extends Record<string, SupervisorIntentValue> = Record<
    string,
    SupervisorIntentValue
  >,
> = {
  /** Stable identifier — used in logs, events, checkpoints, signature. */
  name: string;
  /** Dev-curated version string. Metadata only (§10.2) — never parsed. */
  version?: string;
  /**
   * Per-flow observability routing. `true` routes each turn's report to the
   * globally-registered observers (even with observe-all off); `false` opts
   * out; an `Observer` is a flow-local collector; omitted follows the global
   * observe-all flag. Parity with agent/workflow/supervisor — a durable
   * session root no longer needs a manual `observe.collect()`.
   */
  observe?: FlowObserveOption;
  /** Prepended to the router agent's system prompt (router mode only). */
  systemPrompt?: SystemPromptContract | string;

  /** Dispatchable units keyed by intent name (supervisor surface). */
  intents: TIntents;
  /** Deterministic per-turn dispatch. Mutually exclusive with `router`. */
  route?: (ctx: RouteContext<TState>) => Next | Promise<Next>;
  /** LLM-driven dispatch. Mutually exclusive with `route`. */
  router?: AgentContract<unknown> | RouterEntry<TState>;
  /** Retrospective per-turn verdict callback. */
  evaluate?: (
    ctx: EvaluateContext<TState>,
  ) => EvaluateResult | Promise<EvaluateResult>;
  /** Initial seed for the session-state accumulator. */
  state?: TState;
  /** Final-state schema; validated before populating `result.data`. */
  output?: StandardSchemaV1<TOutput>;
  /** Dispatch this intent on turn 0, skipping the first route/router call. */
  initialAgent?: string;
  /** Hard cap on in-turn iterations — only consulted when `iterate: true`. Default 10. */
  maxIterations?: number;

  /**
   * Delegate each turn to a real internal supervisor for in-turn
   * iteration. Default `false` — single dispatch per turn. Requires
   * `snapshotStore` (or `ai.config({ defaultSnapshotStore })`) when set.
   */
  iterate?: boolean;
  /**
   * Per-role history windowing applied to the dev-supplied history
   * before each turn. A number keeps the last N messages; a callback
   * takes full control of the slice.
   */
  historyWindow?: {
    router?: number | ((messages: Message[]) => Message[]);
    agents?: number | ((messages: Message[]) => Message[]);
  };
  /** Automatic post-turn compaction policy (§12). */
  summarize?: SummarizeConfig | SummarizeCallback;
  /** Number of turn snapshots to retain per session. Default 100. */
  keepSnapshots?: number | "all";

  /** Durable session-state store. Falls back to `ai.config({ defaultCheckpointStore })`. */
  checkpointStore?: CheckpointStore;
  /**
   * Per-session turn serialization (C4). Each `execute` / `stream` /
   * `resume` turn runs under `sessionLock.withLock(sessionId, …)` so a
   * concurrent same-session turn can't race the checkpoint's read-modify-
   * write and lose an update.
   *
   * - Omitted (default) → an in-process mutex keyed by `sessionId`. Fully
   *   serializes same-session turns within ONE process; for a
   *   horizontally-scaled deployment supply a distributed lock instead.
   * - A {@link SessionLock} → your own (e.g. Redis/Postgres advisory
   *   locks) for cross-process serialization.
   * - `false` → no locking. Only when an external mechanism (sticky
   *   routing, single-writer guarantee) already serializes the session.
   *
   * When a durable `checkpointStore` is configured but no explicit lock
   * is supplied, the orchestrator warns once (outside tests) that the
   * in-process default does not protect across processes.
   */
  sessionLock?: SessionLock | false;
  /** Internal-supervisor snapshot store. Required when `iterate: true`. */
  snapshotStore?: SnapshotStore;
  /**
   * Optional per-turn memory (memory core M2). When set, the
   * orchestrator recalls relevant memories for the turn input and injects
   * them into the dispatch context (`ctx.context[injectKey]`) before
   * routing, then remembers the settled turn outcome afterward. Omit for
   * the existing behavior — orchestrators without memory are unchanged.
   * Accepts a bare {@link MemoryContract} (recall + remember with
   * defaults) or an {@link OrchestratorMemoryConfig} for finer control.
   */
  memory?: MemoryContract | OrchestratorMemoryConfig;

  /** Definition-level event handlers — tier 1 of the 3-tier model. */
  on?: OrchestratorEventHandlers;
};
