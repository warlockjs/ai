import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { AgentContract } from "../agent/agent.contract";
import type { Message } from "../conversation-message.type";
import type { EndSentinel } from "../end.type";
import type { AgentResult } from "../result/agent-result.type";
import type { WorkflowResult } from "../result/workflow-result.type";
import type { WorkflowInstance } from "../workflow/workflow.contract";
import type { DispatchContext } from "./dispatch-context.type";
import type { RouteContext } from "./route-context.type";

/**
 * Raw result produced by a dispatched unit — either an agent or a
 * workflow — before any per-intent strip-merge runs.
 *
 * Exposed as a named alias so consumers reading
 * `IterationSnapshot.result[intent].output` know the shape.
 */
export type DispatchRawResult = AgentResult<unknown> | WorkflowResult<unknown>;

/**
 * Object form of an entry in a supervisor's `intents` map (agent
 * variant). Use when you need to override the unit's `description`,
 * customize the per-dispatch input string, declare a state slice via
 * an `output` schema, or supply per-dispatch placeholder values for
 * the agent's systemPrompt template.
 *
 * Every field other than `agent` is optional — the shorthand form
 * (`intents: { triage: triageAgent }`) simply omits all of them.
 *
 * Phase 3.4 (Stage 4b) — `output` shifted from a transformer
 * `(raw) => unknown` to a `StandardSchemaV1` schema (Q11/Q13). The
 * schema declares the slice this intent contributes to supervisor
 * state; agent output is strip-merged against it. `placeholders`
 * is new — feeds into `agent.execute(input, { placeholders })`.
 *
 * @example
 * intents: {
 *   classify: {
 *     agent: classifierAgent,
 *     description: "First-pass classifier",
 *     placeholders: (ctx) => ({ message: ctx.input }),
 *     output: v.object({ classification: v.enum(["billing", "shipping"]) }),
 *   },
 * }
 */
export type IntentEntry = {
  /** The underlying dispatchable unit — an agent or a workflow. */
  agent: AgentContract<unknown> | WorkflowInstance<unknown, unknown>;
  /**
   * Overrides the unit's own `description` when the router agent's
   * per-turn context is assembled. Required fallback when the
   * underlying agent/workflow doesn't carry one.
   */
  description?: string;
  /**
   * Per-intent input composer — escape hatch for the rare case where
   * the agent's user message itself must vary per intent. Runs after
   * routing decides this intent should dispatch. Without it, the
   * agent receives the supervisor's `ctx.input` unchanged.
   */
  input?: (ctx: RouteContext) => string;
  /**
   * Per-dispatch placeholder values for the agent's `systemPrompt`
   * template. Receives the upcoming `DispatchContext` so the
   * computation can read `ctx.state`, `ctx.iterations`, etc. Result
   * is forwarded as `agent.execute(input, { placeholders })` —
   * filling in `{{key}}` references in the agent's systemPrompt.
   *
   * Phase 3.4 — replaces the dropped `composeAgentInput` mechanism
   * for threading prior-iteration context into agents. Use this for
   * "what should the agent know about state right now?" rather than
   * for "what's the agent's user message?" (that's `input`).
   */
  placeholders?: (ctx: DispatchContext) => Record<string, unknown>;
  /**
   * Schema declaring the slice this intent contributes to supervisor
   * state. Agent output is strip-merged against it: only validated
   * keys land on `IterationSnapshot.result[intent].output` AND merge
   * into supervisor `state`.
   *
   * Without `output`: the agent's full `data` (or `text` fallback)
   * passes through to the snapshot but is NOT auto-merged into
   * state — explicit opt-in keeps state clean.
   *
   * Validation failure surfaces as a per-branch error on the
   * iteration snapshot; sibling branches still run.
   */
  output?: StandardSchemaV1<unknown>;
  /**
   * Per-intent successor directive (Phase 3.4 Stage 4d / Q24).
   * After this intent runs and its slice merges into state, the
   * supervisor calls `next(ctx)`:
   *
   * - Returns intent name (or array) → next iteration dispatches
   *   that. **No router LLM call.**
   * - Returns `END` → terminate. **No router call, no evaluate.**
   * - Returns `undefined` → fall back to router/route as today.
   *
   * Precedence: `evaluate` outranks `next`; `next` outranks
   * router/route. Fan-out: each branch's `next` is collected after
   * all branches settle; the union of unique intents drives the
   * next iteration; any `END` terminates; silent branches abstain.
   */
  next?: (ctx: DispatchContext) => string | string[] | EndSentinel | undefined;
  /**
   * Custom history slicer for this intent's agent/workflow. When
   * supplied, REPLACES the default slice (full history clipped by
   * `SupervisorConfig.historyWindow.agents` if set).
   *
   * Precedence: entry `history` callback > `historyWindow.agents` >
   * full history. Return `[]` to send no history at all (handy for
   * pure-retrieval RAG agents that just need the current input).
   *
   * @example
   * intents: {
   *   sales: {
   *     agent: salesAgent,
   *     history: (ctx) => ctx.history.slice(-15),
   *   },
   *   rag: { agent: ragAgent, history: () => [] },
   * }
   */
  history?: (ctx: RouteContext) => Message[] | ReadonlyArray<Message>;
  /**
   * Dispatch mode (Phase 5 / decisions §34).
   *
   * - `"structured"` (default) — agent runs with the per-intent
   *   `output` schema (or a free-form completion if `output` is
   *   absent). Existing behavior; every prior intent keeps it.
   * - `"stream"` — agent runs **without** structured-output coercion.
   *   Raw text deltas forward as `supervisor.agent.streaming` events;
   *   the assembled prose lands on `state[streamTo]` at completion.
   *
   * Stream mode is mutually exclusive with `output` at the intent
   * level — a stream-mode intent declares its state contribution via
   * `streamTo`, not via a schema. The factory throws
   * `SUPERVISOR_INTENT_STREAM_AND_OUTPUT` if both are set, and
   * `SUPERVISOR_INTENT_STREAM_TO_REQUIRED` if `mode === "stream"` and
   * `streamTo` is missing.
   *
   * **Workflow entries do NOT support stream mode in v1** — workflows
   * have no guaranteed single-LLM-text terminal contract. The factory
   * throws if `mode: "stream"` is set on a workflow entry.
   */
  mode?: "structured" | "stream";
  /**
   * State key the assembled stream-mode prose writes into. Required
   * when `mode === "stream"`; ignored otherwise. The supervisor
   * builds `{ [streamTo]: assembledText }` as the branch's output
   * slice and merges it into `state` like any other slice.
   */
  streamTo?: string;
};

/**
 * Callback dispatch shorthand — an intent handled by dev code rather
 * than by an agent or workflow. Same shape as `ai.step({ run })`.
 *
 * Receives a {@link DispatchContext} and returns a value (sync or
 * async). The return value shallow-merges into supervisor state.
 * The framework wraps the return value in a synthesized leaf report
 * (`type: "callback"`, zero usage, real timing). Throws propagate
 * as `SupervisorFailedError` with `cause` set.
 *
 * @example
 * intents: {
 *   refund: async (ctx) => {
 *     const id = await callRefundAPI(ctx.input);
 *     return { refundId: id };  // shallow-merged into ctx.state
 *   },
 * }
 */
export type IntentCallback = (ctx: DispatchContext) => unknown | Promise<unknown>;

/**
 * Object form of a callback intent — preferred when you need a
 * `description` (required under a router) or want per-intent
 * `input` / `output` shapes.
 *
 * Mirrors `ai.step({ run, description, ... })` so users moving
 * between workflow and supervisor see the same vocabulary.
 *
 * Phase 3.4 (Stage 4b) — `output` shifted from a transformer to
 * a `StandardSchemaV1`. Without it, the callback's full return
 * shallow-merges into state. With it, the return is strip-merged
 * to declared keys only.
 *
 * @example
 * intents: {
 *   cancel: {
 *     run: async (ctx) => ({ cancelledId: await cancelOrder(ctx.input) }),
 *     description: "Cancel an order on explicit customer request",
 *     output: v.object({ cancelledId: v.string() }),
 *   },
 * }
 */
export type IntentRunEntry = {
  /** The dispatch callback. Receives a {@link DispatchContext}. */
  run: IntentCallback;
  /**
   * Required when the supervisor is configured with a `router` —
   * otherwise the router LLM has no signal for picking this intent.
   * Optional in deterministic-route mode.
   */
  description?: string;
  /**
   * Per-intent input resolver. Receives a {@link DispatchContext}
   * (the callback's eventual context) and returns the value passed
   * as `ctx.input`. Defaults to the supervisor's input string.
   */
  input?: (ctx: DispatchContext) => unknown;
  /**
   * Per-dispatch placeholder values. Same role as on `IntentEntry` —
   * available on callback entries for symmetry, though callbacks
   * usually don't have a systemPrompt template to fill.
   */
  placeholders?: (ctx: DispatchContext) => Record<string, unknown>;
  /**
   * Schema declaring the slice this callback contributes to
   * supervisor state. Without it, the full return value
   * shallow-merges. With it, return is strip-merged to declared keys.
   */
  output?: StandardSchemaV1<unknown>;
  /**
   * Per-intent successor directive (Phase 3.4 Stage 4d / Q24). See
   * `IntentEntry.next` — same semantics, available on callback
   * intents too.
   */
  next?: (ctx: DispatchContext) => string | string[] | EndSentinel | undefined;
};

/**
 * The accepted shapes for a value in the supervisor's
 * `intents: Record<string, …>` config:
 *
 * - `AgentContract` — shorthand; description inferred from the agent.
 * - `WorkflowInstance` — shorthand; description inferred from the
 *   workflow (must be present).
 * - `IntentCallback` — bare async/sync function shorthand, dispatched
 *   as dev code. Description-less; allowed only in deterministic
 *   `route` mode. Under a router, upgrade to `IntentRunEntry`.
 * - `IntentEntry` — full object form for an agent/workflow with
 *   optional overrides.
 * - `IntentRunEntry` — full object form for a callback intent.
 *
 * The runtime resolver discriminates by checking, in order:
 * `function → "run" in value → "agent" in value → instanceof`.
 * Mixed dispatch fields (e.g. `{ agent, run }`) throw at construction.
 *
 * Every key must ultimately resolve to a non-empty description when
 * the supervisor is configured with a `router` — the factory throws
 * `SupervisorFailedError` (`SUPERVISOR_INTENT_DESCRIPTION_REQUIRED`)
 * if any router-routed intent lacks one. Deterministic-route callers
 * skip the check.
 */
export type SupervisorIntentValue =
  | AgentContract<unknown>
  | WorkflowInstance<unknown, unknown>
  | IntentCallback
  | IntentEntry
  | IntentRunEntry;
