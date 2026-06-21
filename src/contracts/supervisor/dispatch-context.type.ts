import type { AgentContract } from "../agent/agent.contract";
import type { AgentExecuteOptions } from "../agent/agent-options.type";
import type { Message } from "../conversation-message.type";
import type { AgentResult } from "../result/agent-result.type";
import type { SupervisorResult } from "../result/supervisor-result.type";
import type { WorkflowResult } from "../result/workflow-result.type";
import type { StreamContract } from "../stream/stream.contract";
import type { WorkflowInstance, WorkflowRunOptions } from "../workflow/workflow.contract";
import type { ClassifierSnapshot } from "./classifier-context.type";
import type { SupervisorContract } from "./supervisor.contract";
import type { SupervisorExecuteOptions } from "./supervisor-execute-options.type";
import type { SupervisorIntentValue } from "./intent-entry.type";
import type { IterationSnapshot } from "./iteration-snapshot.type";

/**
 * Runner exposed on `DispatchContext.intents` for each registered
 * intent. Two methods, mirroring the canonical execute / stream
 * surface every executable primitive exposes:
 *
 * - `.execute(input?)` runs the named intent and returns its resolved
 *   output value (existing — Phase 3.3).
 * - `.stream(input?)` runs the named intent in streaming mode and
 *   returns a `StreamContract` the caller can iterate or
 *   `await .result` on (Phase 6 / decisions §36). Stream events
 *   bubble up as `supervisor.agent.streaming` under the calling
 *   callback's intent name when the supervisor itself is being
 *   streamed.
 *
 * Without `input` → the dispatched primitive sees the calling
 * callback's own `ctx.input`. With `input` → the override is
 * forwarded.
 *
 * Throws `SupervisorFailedError` (`SUPERVISOR_DISPATCH_CYCLE`) when
 * invoking would close a per-branch call cycle. Cycle detection is
 * scoped per fan-out branch — sibling branches dispatching the same
 * intent in parallel is NOT a cycle.
 *
 * Replaces the Phase-3.3 `ctx.dispatch.byName(name, input?)` helper
 * with property-access + per-key autocomplete (Q5/Q6).
 */
export type IntentRunner = {
  execute: (input?: unknown) => Promise<unknown>;
  stream: (input?: unknown) => StreamContract<SupervisableResult>;
};

/**
 * Discriminated union of executable primitives that `ctx.run`
 * accepts (Phase 6 / decisions §36). Tools are deliberately
 * excluded — they have a different lifecycle and compose via
 * `agent.tools[]`, not via supervised inline dispatch.
 */
export type SupervisableExecutable =
  | AgentContract<unknown>
  | WorkflowInstance<unknown, unknown>
  | SupervisorContract<unknown>;

/**
 * Subset of `SupervisableExecutable` that exposes a native
 * `.stream()` method. Workflows currently expose streaming only
 * through `workflow.step.streaming` events on `.execute()`; their
 * inline streaming via `ctx.stream` is deferred to a future phase.
 * Workflows still work through `ctx.run` — their step-streaming
 * events bubble through the supervisor's existing top-level forward
 * chain.
 */
export type StreamableExecutable =
  | AgentContract<unknown>
  | SupervisorContract<unknown>;

/**
 * Result envelope returned by `ctx.run(executable, ...)` — discriminated
 * by the executable's kind. Callbacks typically know which one they
 * passed and TS narrows accordingly.
 */
export type SupervisableResult =
  | AgentResult<unknown>
  | WorkflowResult<unknown>
  | SupervisorResult<unknown>;

/**
 * Per-call options to `ctx.run` / `ctx.stream`. Each kind's native
 * options pass through; the supervisor auto-merges `signal`,
 * `toolCtx`, and `history` defaults under the option payload before
 * forwarding. Per-call value REPLACES the auto-default — standard
 * Warlock convention.
 */
export type SupervisableExecuteOptions =
  | AgentExecuteOptions<unknown>
  | WorkflowRunOptions
  | SupervisorExecuteOptions;

/**
 * Map of registered intents keyed by their name in the supervisor's
 * `intents` config. Generic-typed against the supplied `intents`
 * object so `ctx.intents.<TAB>` autocompletes against the literal
 * keys the user supplied.
 */
export type IntentRunnerMap<TIntents extends Record<string, SupervisorIntentValue>> = {
  [K in keyof TIntents]: IntentRunner;
};

/**
 * Context passed to callback intents and to per-intent
 * `input(ctx)` / `output(ctx)` resolvers in entries (callback or
 * agent/workflow alike, where the resolver opts into the dispatch
 * shape rather than the legacy `RouteContext`).
 *
 * Sibling of `RouteContext` — same conceptual context, but carries
 * dispatch-specific fields (`intent`, `result`, `intents`) that
 * don't make sense pre-routing.
 *
 * Generic over `TIntents` for autocomplete on `ctx.intents.X`. Most
 * users never write the generic explicitly — it's inferable from
 * the `SupervisorConfig<TOutput, TIntents>` argument.
 *
 * @example
 * intents: {
 *   refund: async (ctx) => {
 *     if (typeof ctx.input === "object" && (ctx.input as { amount: number }).amount > 1_000) {
 *       await ctx.intents.auditLog.execute();
 *     }
 *     return await callRefundAPI(ctx.input);
 *   },
 * }
 */
export type DispatchContext<
  TState = Record<string, unknown>,
  TIntents extends Record<string, SupervisorIntentValue> = Record<string, SupervisorIntentValue>,
> = {
  /** Zero-indexed iteration number — turn 0 is the first run. */
  iteration: number;
  /** This dispatch's intent name (the key from the `intents` map). */
  intent: string;
  /**
   * Resolved input for this intent. Either the supervisor's
   * original `execute(input)` value or the result of the entry's
   * `input(ctx)` resolver when one was supplied.
   */
  input: unknown;
  /**
   * Per-execute typed accumulator. Built up across iterations as
   * each intent contributes a slice via shallow-merge. Read-only
   * from inside callbacks (Q3 — write via return value, not direct
   * mutation). On the supervisor's clean termination, this is the
   * value validated against `config.output` and returned as
   * `result.data`.
   *
   * Defaults to `{}` when `config.state` is not declared. JSON-safe
   * only — no functions / Maps / Sets / class instances (Q16) so
   * snapshot resume works.
   */
  state: TState;
  /**
   * Current iteration's snapshot-in-progress — sibling branches
   * that have already settled this iteration. Empty for the first
   * branch dispatched in any iteration.
   */
  result: IterationSnapshot["result"];
  /**
   * Every completed iteration's snapshot, in chronological order.
   * On turn 0 this is empty.
   *
   * Renamed from `history` (Q2) — the iteration trace is not
   * conversation history; conversation memory is external to the
   * supervisor (Q3).
   */
  iterations: IterationSnapshot[];
  /** Cancellation signal — propagated from the `execute()` caller. */
  signal: AbortSignal;
  /**
   * Registered intents accessible by key. Each entry is an
   * `IntentRunner` exposing `.execute(input?)`. Property access on
   * a typed map replaces the Phase-3.3 `ctx.dispatch.byName` string
   * lookup — autocomplete + no typo crashes.
   */
  intents: IntentRunnerMap<TIntents>;
  /**
   * Read-only request-scoped bag supplied via
   * `execute(input, { context })`. Shallow-copied + frozen at intake
   * so callbacks can't mutate the caller's object. Defaults to a
   * frozen `{}` when no context was passed. NOT persisted in
   * snapshots — re-supply on `resume()`.
   */
  context: Readonly<Record<string, unknown>>;
  /**
   * Prior conversation messages supplied via
   * `execute(input, { history })`. Read-only — passed by reference, not
   * copied. Defaults to an empty array when no history was supplied.
   * NOT persisted in snapshots — re-supply on `resume()`.
   */
  history: ReadonlyArray<Message>;
  /**
   * Resolved natural-language objective from `SupervisorConfig.goal`.
   * `undefined` when the supervisor was configured without one.
   * Read-only.
   */
  goal?: string;
  /**
   * Run an inline / un-registered executable under the supervisor's
   * supervision (Phase 6 / decisions §36). The framework auto-merges
   * `signal`, `toolCtx`, `history`, and report-nesting under the
   * calling callback's intent name. Per-call `options` REPLACE
   * auto-defaults (standard Warlock convention).
   *
   * Use when you need to compose an agent / workflow / supervisor
   * inline that isn't in the `intents` map — e.g. an agent
   * dynamically built from per-call config, or a delegate supervisor
   * pulled from a registry.
   *
   * Returns the executable's full result envelope (`{ data, error,
   * usage, report }`). Calls `.execute()` internally; for streaming,
   * use `ctx.stream` instead.
   *
   * Cycle detection by executable `name` matches `ctx.intents.X.execute()`.
   *
   * @example
   * intents: {
   *   classifyInline: async ctx => {
   *     const { data } = await ctx.run(classifierAgent, ctx.input);
   *     return { category: data.label };
   *   },
   * }
   */
  run: (
    executable: SupervisableExecutable,
    input: unknown,
    options?: SupervisableExecuteOptions,
  ) => Promise<SupervisableResult>;
  /**
   * Stream an inline / un-registered executable under the
   * supervisor's supervision (Phase 6 / decisions §36). Same auto-
   * merge as `ctx.run` plus stream-event bubbling: deltas surface as
   * `supervisor.agent.streaming { iteration, intent: "<callback name>",
   * delta }` when the supervisor itself is being streamed.
   *
   * Returns the executable's own `StreamContract` — iterate with
   * `for await`, `await .result`, or both. The framework attaches
   * subscriptions transparently; the dev's existing usage of the
   * returned stream is unchanged.
   *
   * @example
   * intents: {
   *   chatInline: async ctx => {
   *     const { result } = ctx.stream(someAgent, enrich(ctx.input));
   *     const final = await result;
   *     return { reply: final.text };
   *   },
   * }
   */
  stream: (
    executable: StreamableExecutable,
    input: unknown,
    options?: SupervisableExecuteOptions,
  ) => StreamContract<SupervisableResult>;
  /**
   * Forensic record of iter-0 classifier run (Phase 7 / decisions §37).
   * Present when `SupervisorConfig.classifier` was configured AND
   * iter 0 has completed; `undefined` otherwise. Callbacks can
   * read `ctx.classifier?.intent` / `.reasoning` / `.confidence` to
   * inspect the classification trail without round-tripping through
   * state.
   */
  classifier?: Readonly<ClassifierSnapshot>;
};
