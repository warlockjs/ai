import type { AgentContract } from "../agent/agent.contract";
import type { Message } from "../conversation-message.type";
import type { RouteContext } from "./route-context.type";

/**
 * Object form for `SupervisorConfig.router` — symmetric with
 * `IntentEntry`, but a strict subset:
 *
 * - `agent` — the routing LLM agent. Required.
 * - `placeholders` — values fed into the router agent's
 *   `systemPrompt` template. Lets dev surface state-aware context
 *   ("user is a VIP", "iteration budget remaining") into the routing
 *   prompt without forcing it through the user-message scaffolding.
 * - `input` — full override for the per-turn user message the router
 *   agent receives. By default the supervisor builds a structured
 *   message (intents list + state + feedback + original input).
 *   Returning a string here REPLACES that scaffolding entirely —
 *   you take responsibility for surfacing whatever the router needs
 *   to make its decision.
 *
 * Deliberately omits:
 * - `description` — the router isn't an intent, has no peer to
 *   describe itself to.
 * - `output` — the framework owns the canonical `{ next, reasoning }`
 *   schema; overriding it would silently break dispatch resolution.
 * - `next` — the router IS the dispatcher; a `next` directive on
 *   the router itself is meaningless.
 *
 * Shorthand: passing a bare `AgentContract` to `router` is equivalent
 * to `{ agent }` — same as `IntentEntry`'s shorthand on `intents`.
 */
export type RouterEntry<TState = Record<string, unknown>> = {
  /** The router agent — must declare an output that includes `next`. */
  agent: AgentContract<unknown>;
  /**
   * Per-turn template values fed into the router agent's
   * `systemPrompt`. Receives the same `RouteContext` the route
   * callback would.
   */
  placeholders?: (ctx: RouteContext<TState>) => Record<string, unknown>;
  /**
   * Replaces the supervisor's default per-turn user message.
   * Returning a string short-circuits the built-in scaffolding —
   * the router sees only what you produce.
   */
  input?: (ctx: RouteContext<TState>) => string;
  /**
   * Custom history slicer for the router agent. When supplied, REPLACES
   * the default slice (full history clipped by
   * `SupervisorConfig.historyWindow.router` if set) — return whatever
   * subset/transformation the router should see.
   *
   * Precedence: `history` callback > `historyWindow.router` > full
   * history. Return `[]` to send no history at all.
   *
   * @example
   * router: {
   *   agent: routerAgent,
   *   // last 3 user turns only — keep router prompt small
   *   history: (ctx) => ctx.history.filter(m => m.role === "user").slice(-3),
   * }
   */
  history?: (ctx: RouteContext<TState>) => Message[] | ReadonlyArray<Message>;
};
