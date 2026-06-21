import type { AIError } from "../../errors/ai-error";
import type { ToolInvokeResult } from "../../tool";
import type { ModelResponse } from "../model.contract";
import type { AgentResult } from "../result/agent-result.type";
import type { SupervisorResult } from "../result/supervisor-result.type";
import type {
  MiddlewareExecuteContext,
  MiddlewareSupervisorContext,
  MiddlewareToolContext,
  MiddlewareTripContext,
} from "./middleware-context.type";

/**
 * `execute`-level hook map. Wraps the entire `agent.execute()` call.
 *
 * - `before` — fires once at the start of the run. Throw to abort the
 *   whole execution before any model call is made (e.g. budget pre-check,
 *   hard deny based on a ctx flag).
 * - `after`  — fires once at the end of a successful run with the final
 *   `AgentResult`. Optional return value replaces the result. Does not
 *   fire when the run errored — use `onError` for that path.
 * - `onError`— fires once when the run aborted with an error. Optional
 *   return value recovers: the engine treats the returned `AgentResult`
 *   as the real outcome and clears the error. `void` / omitted rethrow.
 */
export type AgentMiddlewareExecuteHooks = {
  before?(ctx: MiddlewareExecuteContext): void | Promise<void>;
  after?(
    ctx: MiddlewareExecuteContext,
    result: AgentResult<unknown>,
  ): void | AgentResult<unknown> | Promise<void | AgentResult<unknown>>;
  onError?(
    ctx: MiddlewareExecuteContext,
    error: AIError,
  ): void | AgentResult<unknown> | Promise<void | AgentResult<unknown>>;
};

/**
 * `trip`-level hook map. Wraps each model round-trip individually.
 *
 * - `before` — fires just before `model.complete()` / `model.stream()`.
 *   Return a `ModelResponse` to short-circuit the call entirely
 *   (semantic cache hit, offline fixture replay). Throw to abort the
 *   trip with a typed error (guardrail input rejection).
 * - `after`  — fires immediately after a successful model response.
 *   Optional `ModelResponse` return replaces the response before the
 *   engine builds its `LLMTrip` record or dispatches tool calls.
 * - `onError`— fires when the model call threw. Return a `ModelResponse`
 *   to recover (fallback chain), or `void` to propagate the error up.
 */
export type AgentMiddlewareTripHooks = {
  before?(
    ctx: MiddlewareTripContext,
  ): void | ModelResponse | Promise<void | ModelResponse>;
  after?(
    ctx: MiddlewareTripContext,
    response: ModelResponse,
  ): void | ModelResponse | Promise<void | ModelResponse>;
  onError?(
    ctx: MiddlewareTripContext,
    error: AIError,
  ): void | ModelResponse | Promise<void | ModelResponse>;
};

/**
 * `tool`-level hook map. Wraps each tool dispatch individually.
 *
 * - `before` — fires just before the wrapped `tool.invoke()`. Return a
 *   `ToolInvokeResult` to short-circuit (cached tool response, hard
 *   rate-limit rejection). Throw to abort the agent with a typed error.
 * - `after`  — fires after a successful tool invocation. Optional
 *   `ToolInvokeResult` return replaces the result before the engine
 *   records it into `toolCalls` / the next trip's messages.
 * - `onError`— fires when the tool threw synchronously (rare — `invoke`
 *   itself never throws; this covers catastrophic runtime crashes in
 *   the pipeline wrap). Return a `ToolInvokeResult` to recover.
 */
export type AgentMiddlewareToolHooks = {
  before?(
    ctx: MiddlewareToolContext,
  ):
    | void
    | ToolInvokeResult<unknown>
    | Promise<void | ToolInvokeResult<unknown>>;
  after?(
    ctx: MiddlewareToolContext,
    result: ToolInvokeResult<unknown>,
  ):
    | void
    | ToolInvokeResult<unknown>
    | Promise<void | ToolInvokeResult<unknown>>;
  onError?(
    ctx: MiddlewareToolContext,
    error: AIError,
  ):
    | void
    | ToolInvokeResult<unknown>
    | Promise<void | ToolInvokeResult<unknown>>;
};

/**
 * `supervisor`-level hook map. Wraps the entire `supervisor.execute()`
 * / `.stream()` / `.resume()` run — the supervisor-level peer of
 * `AgentMiddlewareExecuteHooks`. Fires once per run, around the whole
 * iteration loop and final result assembly.
 *
 * - `before` — fires once at the start of the run, before the first
 *   routing decision. Throw to abort the whole supervisor run before
 *   any iteration executes (cross-run budget pre-check, hard deny on
 *   a ctx flag). Return a `SupervisorResult` to short-circuit the run
 *   entirely with that result (run-level cache hit, fixture replay).
 * - `after`  — fires once at the end of a successful run with the
 *   final `SupervisorResult`. Optional return value replaces the
 *   result. Does not fire when the run threw before producing a
 *   result — use `onError` for that path. (A run that completed with
 *   `result.error` populated is still a "successful" return here, the
 *   same as agent-level `execute.after`.)
 * - `onError`— fires once when the run threw before a result could be
 *   assembled. Optional `SupervisorResult` return recovers: the engine
 *   treats it as the real outcome and clears the error. `void` /
 *   omitted rethrow.
 *
 * **Type independence.** Like every other level, supervisor hooks are
 * never generic over the supervisor's `TOutput` — a budget or audit
 * middleware must be reusable across every supervisor in the app, so
 * hooks see `SupervisorResult<unknown>`.
 */
export type AgentMiddlewareSupervisorHooks = {
  before?(
    ctx: MiddlewareSupervisorContext,
  ): void | SupervisorResult<unknown> | Promise<void | SupervisorResult<unknown>>;
  after?(
    ctx: MiddlewareSupervisorContext,
    result: SupervisorResult<unknown>,
  ): void | SupervisorResult<unknown> | Promise<void | SupervisorResult<unknown>>;
  onError?(
    ctx: MiddlewareSupervisorContext,
    error: AIError,
  ): void | SupervisorResult<unknown> | Promise<void | SupervisorResult<unknown>>;
};

/**
 * Agent-level middleware — a composable interceptor that wraps agent
 * execution at one or more of three granularities: the whole
 * `agent.execute()` call (`execute`), each LLM round-trip (`trip`),
 * and each tool dispatch (`tool`).
 *
 * **Role.** The single authoring surface for cross-cutting concerns
 * around an agent: budgets, guardrails, semantic cache, observability
 * exports, fallback chains. One middleware = one config object.
 * Middleware declares **any subset** of the three level hook maps; the
 * pipeline skips levels a given middleware doesn't care about.
 *
 * **Ordering.** Registration order defines execution order: for every
 * level, `before` hooks run top-down through the array, `after` and
 * `onError` hooks run bottom-up (onion model — same mental picture as
 * Koa / Express middleware). No priority numbers. The canonical
 * install order documented in the subskill is:
 * `[cache, budget, guardrail, observability]`.
 *
 * **Abort vs. synthetic-return.** Middleware has two ways to change
 * behavior. Throwing an `AIError` aborts the wrapped operation (the
 * error surfaces on `result.error` — `execute()` still never throws).
 * Returning a value from a `before` hook short-circuits the wrapped
 * operation with that value as its result, skipping the real work
 * and running `after` hooks in reverse as if the wrapped operation
 * had produced the value itself. Cache hits use the short-circuit
 * path; budgets and guardrails use the throw path.
 *
 * **State.** Middleware never holds mutable state in closure — a
 * single middleware object may be registered on multiple agents, or
 * invoked by concurrent `execute()` calls on the same agent. Use
 * `ctx.state` (fresh per execution) for any cross-hook bookkeeping.
 *
 * **Type independence.** Middleware is never generic over the agent's
 * `TOutput`. A budget or guardrail must be reusable across every
 * agent in the app, so all level hooks see `AgentResult<unknown>` and
 * `AgentExecuteOptions<unknown>`. Output-specific logic belongs in
 * the caller or in a purpose-built middleware for that agent.
 *
 * @example
 * const budget: AgentMiddleware = {
 *   name: "budget",
 *   execute: {
 *     before(ctx) { ctx.state.set("budget.used", 0); },
 *   },
 *   trip: {
 *     after(ctx, response) {
 *       const used = (ctx.state.get("budget.used") as number) + response.usage.total;
 *       ctx.state.set("budget.used", used);
 *       if (used > 1_000) throw new BudgetExceededError("token cap", { limit: 1_000, actual: used, unit: "tokens" });
 *     },
 *   },
 * };
 *
 * const myAgent = agent({
 *   model,
 *   middleware: [budget],
 * });
 */
export type AgentMiddleware = {
  /**
   * Stable identifier for this middleware — used in logs, as the
   * state-bag namespace prefix, and in the canonical install-order
   * documentation. Should be kebab-case.
   */
  name: string;
  /**
   * Optional per-middleware log kill-switch. `false` silences the
   * pipeline's `debug`-level trace for this middleware only; other
   * middlewares in the same pipeline continue logging. Default `true`.
   */
  log?: boolean;
  execute?: AgentMiddlewareExecuteHooks;
  trip?: AgentMiddlewareTripHooks;
  tool?: AgentMiddlewareToolHooks;
  /**
   * Optional `supervisor`-level hook map — wraps an entire
   * `supervisor.execute()` run, the supervisor-level peer of
   * `execute`. Only fires when the middleware is registered on a
   * supervisor (`ai.supervisor({ middleware: [...] })`); it is inert on
   * a plain agent, exactly as `execute` / `trip` / `tool` are inert on
   * a supervisor that never reaches the agent pipeline. A single
   * middleware object may declare both `execute` and `supervisor` to
   * cover both authoring surfaces.
   */
  supervisor?: AgentMiddlewareSupervisorHooks;
};
