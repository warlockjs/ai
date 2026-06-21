import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { SnapshotStore } from "../orchestrator/snapshot-store.contract";
import type { AgentContract } from "../agent/agent.contract";
import { Message } from "../conversation-message.type";
import type { AgentMiddleware } from "../middleware/middleware.contract";
import type { SupervisorEventMap } from "../events/event-map.type";
import type { SystemPromptContract } from "../system-prompt.contract";
import type { AckConfig } from "./ack-entry.type";
import type { ClassifierConfig } from "./classifier-context.type";
import type { EvaluateContext, EvaluateResult } from "./evaluate-context.type";
import type { SupervisorIntentValue } from "./intent-entry.type";
import type { Next } from "./next.type";
import type { RouteContext } from "./route-context.type";
import type { RouterEntry } from "./router-entry.type";
import type { SupervisorInput } from "./supervisor-input.type";

/**
 * Handler function for a single supervisor event. Receives the
 * event's typed payload; return value is ignored.
 */
export type SupervisorEventHandler<K extends keyof SupervisorEventMap> = (
  payload: SupervisorEventMap[K],
) => void;

export type SupervisorEventHandlers = Partial<{
  [K in keyof SupervisorEventMap]: SupervisorEventHandler<K>;
}>;

/**
 * Full factory config for `ai.supervisor(config)`.
 *
 * Two dispatch modes are exposed as mutually-exclusive top-level
 * fields: `route` (deterministic callback) XOR `router` (LLM-driven
 * agent). The factory throws `SupervisorFailedError` at author time
 * when both or neither is present. `evaluate` pairs with both `route`
 * and `router` (Phase 3.4 Q9 — the earlier router-only restriction
 * was lifted).
 *
 * `intents` is a `Record<string, …>` — keys are intent names the
 * router/route emits. Values are shorthand `AgentContract` /
 * `WorkflowInstance` or the full `IntentEntry` object form. (Phase
 * 3.3 stage 3b extends the union with callback dispatch.)
 *
 * `output` is a Standard Schema; when provided, supervisor validates
 * the final value before populating `result.data`. On failure the
 * error surfaces via `result.error` (never thrown).
 *
 * Phase 3.4 (Stage 4c) — `combine` removed. Fan-out branches now
 * shallow-merge into supervisor `state` via per-intent `output`
 * schemas (Q11/Q15). Use a callback-orchestrator intent for custom
 * merging (max, sum, deep merge): dispatch siblings via
 * `ctx.intents.X.execute()` and assemble the result yourself.
 *
 * @example
 * const supervisor = ai.supervisor<{ response: string; refund: boolean }>({
 *   name: "customer-support",
 *   systemPrompt: ai.systemPrompt().persona("You coordinate a support team."),
 *   router: routerAgent,
 *   intents: { triage, orderLookup, billingLookup, resolver },
 *   evaluate: (ctx) =>
 *     ctx.state.response ? { satisfied: true } : undefined,
 *   maxIterations: 6,
 *   output: v.object({ response: v.string(), refund: v.boolean() }),
 *   snapshotStore: ai.snapshot.redis({ client }),
 * });
 */
export type SupervisorConfig<
  TOutput = unknown,
  TState = TOutput,
  TIntents extends Record<string, SupervisorIntentValue> = Record<string, SupervisorIntentValue>,
  TArtifacts = Record<string, unknown>,
> = {
  /** Stable identifier — used in logs, events, snapshots, signature. */
  name: string;

  /**
   * Dev-curated version string mirrored onto every report node this
   * supervisor produces. Free-form — semver, date, hash. Bump when
   * routing logic, intent set, or evaluate criteria change in a way
   * worth distinguishing in trip archives. The framework neither
   * parses nor compares it; signature drift detection remains
   * independent.
   */
  version?: string;

  /**
   * Opt-in Standard Schema describing this supervisor's input. Purely
   * additive — when set, the supervisor can be dropped straight into an
   * agent's `tools: []` array WITHOUT calling `.asTool()`: the runtime
   * derives the LLM tool manifest from `name` + the resolved
   * description + this schema and dispatches through `execute()`. Omit
   * it and `.asTool()` (which takes its own `inputSchema`) remains the
   * way to expose the supervisor as a tool. Not enforced by the
   * supervisor runtime itself — `execute()` still accepts the raw
   * `SupervisorInput` union.
   */
  inputSchema?: StandardSchemaV1<SupervisorInput>;

  /**
   * Prepended to the router agent's own system prompt (router mode
   * only). Does not touch child agents' system prompts — they stay
   * independent, reusable units.
   */
  systemPrompt?: SystemPromptContract | string;

  /**
   * Natural-language statement of what "done" looks like for this
   * supervisor — the high-level objective every iteration is
   * working toward. First-class concept rather than buried in
   * `systemPrompt` so:
   *
   * - The router agent's per-turn user message includes it explicitly,
   *   so routing decisions are objective-aware without manual prompt
   *   stuffing.
   * - `route` / `evaluate` / dispatch callbacks receive it on
   *   `ctx.goal` (read-only) for state-driven satisfaction checks
   *   without hardcoded strings.
   * - Dispatched agents can reference it via the `{{goal}}`
   *   placeholder on their own systemPrompt templates without the
   *   supervisor wiring it through `entry.placeholders` manually.
   *
   * Accepts a plain `string` or a `SystemPromptContract` (for
   * placeholder-rendered goals); resolved to text at construction.
   *
   * NOT persisted in snapshots — re-resolved from the config on
   * `resume()`.
   *
   * @example
   * ai.supervisor({
   *   name: "ac-recommender",
   *   goal: "Recommend an AC unit. Must include BTU calculation, " +
   *         "matching catalog product, and city-specific install notes.",
   *   router: routerAgent,
   *   intents: { ... },
   *   evaluate: (ctx) => {
   *     if (ctx.state.recommendation && ctx.state.btu && ctx.state.installNotes) {
   *       return { satisfied: true };
   *     }
   *     return undefined;
   *   },
   * });
   */
  goal?: string | SystemPromptContract;

  /**
   * Factory-level default conversation history — the prior turns the
   * supervisor (router + every dispatched agent + ack) sees on each
   * `execute()` call when the caller does NOT supply per-call history.
   *
   * **Precedence:** `execute(input, { history })` (per-call) overrides
   * this entirely when supplied. When neither is set, history is `[]`.
   *
   * Use this for "background" priming messages every run should see —
   * onboarding context, persona warm-up, baseline tenant info. For
   * actual chat-driver scenarios where each turn carries fresh prior
   * turns, pass `history` per-call via `execute()` instead.
   *
   * Subject to the same `historyWindow` slicing + per-entry `history`
   * callbacks as per-call history once resolved.
   *
   * NOT persisted in snapshots — `resume()` re-resolves it from the
   * config (or per-call `history` on the resume options).
   */
  history?: Message[];

  /**
   * LLM-driven dispatch. Accepts either a bare `AgentContract`
   * (shorthand) or a `RouterEntry` object — `{ agent, placeholders?,
   * input? }` — symmetric with `IntentEntry`. The framework injects
   * the canonical `{ next, reasoning }` output schema; do not declare
   * a custom `output` for the router agent. Mutually exclusive with
   * `route`.
   */
  router?: AgentContract<unknown> | RouterEntry<TState>;

  /**
   * Deterministic dispatch. Runs once per iteration to pick the next
   * intent(s) or terminate. Mutually exclusive with `router`.
   */
  route?: (ctx: RouteContext<TState>) => Next | Promise<Next>;

  /**
   * Dispatchable units keyed by intent name. Shorthand accepts any
   * `AgentContract` or `WorkflowInstance`; full form is `IntentEntry`
   * with optional overrides for `description`, `input`, `output`.
   * Callback dispatch (`run` shorthand / `IntentRunEntry`) is wired
   * into the union in Phase 3.3.
   *
   * Typed as the literal `TIntents` shape so `ctx.intents.<TAB>`
   * autocompletes against the actual keys the user supplied (Q6).
   */
  intents: TIntents;

  /**
   * Retrospective verdict callback. Fires after the iteration's
   * intents settle and their outputs have merged into state — never
   * before dispatch. Pairs with both `router` AND `route` modes
   * (Phase 3.4 Q9 — restriction lifted; state-driven termination is
   * useful in either dispatch mode).
   *
   * Receives `ctx.state` (post-merge) so verdicts can be state-aware.
   */
  evaluate?: (ctx: EvaluateContext<TState>) => EvaluateResult | Promise<EvaluateResult>;

  /**
   * Initial seed for the per-execute state accumulator. Defaults to
   * `{}`. Each intent contributes a slice via shallow-merge across
   * iterations; the final shape is validated against `output` at
   * termination.
   *
   * `TState` defaults to `TOutput` — for the common case where state
   * IS the output shape, you only declare the schema once. Override
   * `TState` (second generic) when the working accumulator carries
   * intermediate fields that don't survive validation.
   *
   * Must be JSON-serializable (Q16) — no functions / Maps / Sets /
   * class instances. Snapshot resume rehydrates `state` from the
   * last persisted iteration.
   */
  state?: TState;

  /**
   * Hard cap on iteration count. Hitting the cap terminates the run
   * with `MaxIterationsError` on `result.error`. Default: `10`.
   */
  maxIterations?: number;

  /**
   * When set, turn 0 dispatches this intent directly and skips the
   * first router/route call. Must be a key in `intents`.
   */
  initialAgent?: string;

  /**
   * Final-state schema. On clean termination the supervisor's
   * accumulated `state` is validated against this; success populates
   * `result.data`, failure surfaces `SchemaValidationError` on
   * `result.error`.
   *
   * Phase 3.4 (Stage 4b) — semantics shifted from "validates the
   * terminal iteration's value" to "validates the accumulated
   * state." Same field name; broader role.
   */
  output?: StandardSchemaV1<TOutput>;

  /**
   * Optional durable {@link SnapshotStore} enabling
   * `supervisor.resume(runId)`. Snapshots are written after every
   * iteration settles plus once more at final completion / cancel /
   * fail. Construct with `ai.snapshot.{memory,pg,redis}()` —
   * `ai.snapshot.memory()` for dev/tests, `ai.snapshot.redis()` /
   * `ai.snapshot.pg()` for production.
   *
   * Falls back to `ai.config({ defaultSnapshotStore })` when omitted.
   * When neither is set, `resume()` throws and snapshot writes silently
   * skip (current behavior preserved).
   */
  snapshotStore?: SnapshotStore;

  /**
   * Definition-level event handlers — tier 1 of the 3-tier model.
   * Fire on every run of this supervisor, before instance and
   * per-call handlers.
   */
  on?: SupervisorEventHandlers;

  /**
   * Optional receptionist — fires in parallel with phase A on
   * iteration 0 only. Streams a brief acknowledgment to the user the
   * moment its first token lands so the UI doesn't show a blank
   * screen while a slow router or specialist works.
   *
   * Three accepted shapes (order of conciseness):
   * - `AckEntry` — `{ agent, placeholders?, input?, output? }` (LLM)
   * - `AckRunEntry` — `{ run, output? }` (pure-code callback)
   * - `AckCallback` — bare `(ctx) => slice` (shorthand)
   *
   * Loses gracefully — if ack hasn't settled by the time the run is
   * otherwise ready to finalize, the slice drops with a warning log
   * and the run completes regardless. See `AckConfig` for full
   * runtime semantics.
   */
  ack?: AckConfig<TState>;

  /**
   * One-shot iter-0 prelude that classifies the input and dispatches
   * the chosen intent (Phase 7 / decisions §37). Composes with
   * `router` / `route` — when both are configured, classifier drives
   * iter 0 and router/route picks up at iter 1+. When classifier is
   * configured alone (no router, no route), the supervisor terminates
   * after iter 0's branch settles.
   *
   * Accepts the same value-shape union as `intents` and `router`:
   * bare `AgentContract` shorthand, bare callback shorthand, or full
   * object form (`{ agent, placeholders?, input?, history?, refine? }`
   * or `{ run, refine? }`).
   *
   * Output schema is locked at the framework level —
   * `{ intent, reasoning?, confidence? }`. Devs may extend with
   * additional fields by declaring a richer typed schema on their
   * classifier agent; the extra fields strip-merge into supervisor
   * state per the supervisor's `output` schema.
   *
   * **Mutually exclusive with `initialAgent`** — both answer "what
   * runs first?" and coexistence is meaningless. Factory throws
   * `SupervisorFailedError` when both are set.
   *
   * @example
   * classifier: {
   *   agent: classifyAgent,
   *   refine: async ctx => {
   *     // Override on weak-confidence signal:
   *     if ((ctx.result.data.confidence ?? 1) < 0.7) {
   *       return { intent: "fallback" };
   *     }
   *     // Halt on policy violation:
   *     if (isToxic(ctx.input)) {
   *       return END;
   *     }
   *   },
   * }
   */
  classifier?: ClassifierConfig<TState>;
  /**
   * Global default windows applied to the prior conversation history
   * supplied via `execute(input, { history })` — keeps the **last N**
   * messages (most recent, chronological) per role.
   *
   * - `router` — slice for the routing LLM. Recommended small (3–5)
   *   since the router only needs recent intent signal. Default:
   *   unbounded.
   * - `agents` — slice for every dispatched agent/workflow. Default:
   *   unbounded.
   * - `ack` — slice for the receptionist. Default: `0` — receptionists
   *   are template-y and rarely need scroll-back; full history wastes
   *   tokens on a path explicitly chosen for speed. Override per-call
   *   via the entry `history` callback when needed.
   *
   * Precedence (per role): entry-level `history` callback >
   * `historyWindow.<role>` > full history (or empty for ack).
   *
   * @example
   * historyWindow: { router: 5, agents: 10 }
   */
  historyWindow?: {
    router?: number;
    agents?: number;
    ack?: number;
  };

  /**
   * Schema for the artifacts bag tools may write into via
   * `ctx.artifacts` (Phase 5 / decisions §35). Declared once on the
   * supervisor; threaded into every tool registered to the
   * supervisor's agents so `ctx.artifacts.*` autocompletes against
   * `TArtifacts`.
   *
   * The bag starts empty at every iteration boundary, accumulates
   * across all tool calls in that iteration, validates against this
   * schema (when set), then merges into supervisor `state` via
   * `finalizeArtifacts` if supplied — otherwise via auto-spread.
   *
   * Validation failure aborts the run with
   * `SchemaValidationError` carrying the offending iteration on
   * `result.error`.
   *
   * @example
   * artifactsSchema: v.object({
   *   blocks: v.array(blockSchema).optional(),
   *   citations: v.array(citationSchema).optional(),
   * }),
   */
  artifactsSchema?: StandardSchemaV1<TArtifacts>;

  /**
   * Supervisor-level middleware — fires the optional `supervisor` hook
   * map (`before` / `after` / `onError`) of each `AgentMiddleware`
   * once around the entire `execute()` / `stream()` / `resume()` run,
   * the supervisor-level peer of an agent's `execute`-level middleware.
   *
   * Same onion semantics as the agent pipeline: `before` runs top-down
   * (return a `SupervisorResult` to short-circuit the whole run, throw
   * to abort it), `after` / `onError` run bottom-up (return a
   * `SupervisorResult` to replace / recover). A middleware without a
   * `supervisor` hook map is skipped — so the same builtin objects
   * (budget, guardrail, …) can be registered here and on agents,
   * declaring whichever level applies.
   *
   * Each middleware needs a unique `name` (the `ctx.state` namespace);
   * the supervisor does not re-validate the array — register the same
   * objects you validated for the agents.
   *
   * @example
   * ai.supervisor({
   *   name: "support",
   *   router,
   *   intents: { ... },
   *   middleware: [auditTrail],
   * });
   */
  middleware?: AgentMiddleware[];

  /**
   * Per-iteration merger for the artifacts bag (Phase 5 /
   * decisions §35). When omitted the framework auto-spreads:
   * `state = { ...state, ...artifacts }`. Replace semantics —
   * artifact values overwrite same-keyed state values.
   *
   * Supply this callback for concat / dedupe / transform / cross-
   * iteration accumulation. Typical pattern: blocks should
   * accumulate across iterations rather than replace, so the
   * callback concatenates `state.blocks ?? []` with
   * `artifacts.blocks ?? []`.
   *
   * Called once per iteration with the post-branch-merge state and
   * the iteration's accumulated artifacts. The bag resets to `{}`
   * for the next iteration regardless of what the callback does.
   *
   * @example
   * finalizeArtifacts: (state, artifacts) => ({
   *   ...state,
   *   blocks: [...(state.blocks ?? []), ...(artifacts.blocks ?? [])],
   * }),
   */
  finalizeArtifacts?: (state: TState, artifacts: TArtifacts) => TState;
};
