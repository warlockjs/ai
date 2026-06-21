import type { AgentExecuteOptions } from "../agent/agent-options.type";
import type { Message } from "../conversation-message.type";
import type { ModelToolCallRequest } from "../model-tool-call-request.type";
import type { SupervisorExecuteOptions } from "../supervisor/supervisor-execute-options.type";
import type { SupervisorInput } from "../supervisor/supervisor-input.type";
import type { ToolMode } from "../tool.contract";
import type { MiddlewareState } from "./middleware-state.type";

/**
 * Minimal identity shape of the agent the middleware is wrapping.
 * Middleware never mutates the agent itself, so it sees only the
 * fields it can usefully branch on — name (for logs, per-agent
 * allow-lists) and whether the name was auto-synthesized.
 */
export type MiddlewareAgentRef = {
  readonly name: string;
  readonly isAnonymous: boolean;
};

/**
 * Minimal identity shape of the model the agent is wrapping.
 * Surface just enough for middleware to branch on (budget uses
 * provider/model to look up pricing, semantic cache uses model name
 * in its namespace key). Never includes the live adapter instance.
 */
export type MiddlewareModelRef = {
  readonly name: string;
  readonly provider?: string;
};

/**
 * Context passed to the outermost (`execute`) middleware phase —
 * fires once around the entire `agent.execute()` call.
 *
 * **Role.** Gives middleware the stable identity of the run (agent,
 * input, options) and the shared-state bag all downstream hooks will
 * see. Anything cumulative-across-trips lives here: total token
 * count, wall-clock budget, per-session rate limit counters.
 *
 * All fields are `readonly` — middleware reads them freely but does
 * not reassign. State mutations go through `ctx.state` so there is
 * exactly one mutable surface and it is explicit at the call site.
 */
export type MiddlewareExecuteContext = {
  readonly agent: MiddlewareAgentRef;
  readonly model: MiddlewareModelRef;
  readonly input: string;
  readonly options: AgentExecuteOptions<unknown> | undefined;
  readonly state: MiddlewareState;
  readonly signal?: AbortSignal;
};

/**
 * Context passed to per-LLM-trip middleware hooks — fires once per
 * round trip the agent makes to the model.
 *
 * **Role.** Lets middleware intercept individual model calls:
 * guardrails inspect the outbound `messages` / inbound response,
 * semantic cache short-circuits a trip entirely by returning a
 * synthetic `ModelResponse` from `trip.before`.
 *
 * Extends `MiddlewareExecuteContext` so anything a `before(execute)`
 * hook stashed in `state` is still visible here — the whole point of
 * threading one `state` reference through all levels.
 */
export type MiddlewareTripContext = MiddlewareExecuteContext & {
  readonly tripIndex: number;
  readonly messages: ReadonlyArray<Message>;
};

/**
 * Context passed to per-tool-call middleware hooks — fires once per
 * tool the model asks the agent to invoke.
 *
 * **Role.** Lets middleware wrap individual tool dispatches:
 * rate-limit a specific tool, validate inputs beyond the schema,
 * short-circuit with a cached tool response. Exposes the originating
 * `ModelToolCallRequest` so middleware can log/inspect the exact
 * args the model produced.
 *
 * Extends `MiddlewareTripContext` so tool hooks can branch on the
 * surrounding trip context when useful (e.g. "skip rate-limit on
 * repair trips").
 */
export type MiddlewareToolContext = MiddlewareTripContext & {
  readonly tool: {
    readonly name: string;
    readonly description?: string;
    /**
     * Result-feedback mode of the tool being dispatched. `"feedback"`
     * (default) for standard round-trip tools; `"silent"` for
     * fire-and-forget side-effect tools whose result is not fed back
     * to the model. Exposed so middleware (cost accounting, logging,
     * telemetry) can branch on tool semantics — e.g. skip the
     * post-tool-call usage projection for silent terminal trips since
     * the loop ends there.
     */
    readonly mode?: ToolMode;
  };
  readonly request: ModelToolCallRequest;
};

/**
 * Minimal identity shape of the supervisor a `supervisor`-level
 * middleware is wrapping. Middleware never mutates the supervisor
 * itself, so it sees only the fields it can usefully branch on — the
 * stable `name` (logs, per-supervisor allow-lists) and the structural
 * `signature` (cache-key namespacing, drift-aware observability).
 */
export type MiddlewareSupervisorRef = {
  readonly name: string;
  readonly signature: string;
};

/**
 * Context passed to the `supervisor`-level middleware phase — fires
 * once around the entire `supervisor.execute()` / `.stream()` /
 * `.resume()` run, wrapping the iteration loop and final assembly.
 *
 * **Role.** The supervisor-level peer of {@link MiddlewareExecuteContext}.
 * Gives middleware the stable identity of the run (supervisor, input,
 * options) and a shared-state bag scoped to this one run. Anything
 * cumulative across the whole supervisor lifecycle lives here:
 * cross-iteration budgets, per-session rate-limit counters, audit
 * correlation ids.
 *
 * Deliberately NOT an extension of {@link MiddlewareExecuteContext} —
 * a supervisor has no single model, and its `input` is the wider
 * `SupervisorInput` union (`string | Record<string, unknown>`), so the
 * shapes diverge. The `state` bag is a fresh `Map` per run, matching
 * the agent-level isolation guarantee.
 *
 * All fields are `readonly`; mutations go through `ctx.state`.
 */
export type MiddlewareSupervisorContext = {
  readonly supervisor: MiddlewareSupervisorRef;
  readonly input: SupervisorInput;
  readonly options: SupervisorExecuteOptions | undefined;
  readonly state: MiddlewareState;
  readonly signal?: AbortSignal;
};
