import type { Message } from "../conversation-message.type";
import type { SupervisorEventHandlers } from "./supervisor-config.type";

/**
 * Per-call options for `supervisor.execute()`. Everything here is
 * scoped to a single run — factory-level knobs live on
 * `SupervisorConfig`.
 *
 * @example
 * const controller = new AbortController();
 * const result = await supervisor.execute("order #123 late", {
 *   runId: "support-2026-04-23-123",
 *   signal: controller.signal,
 *   on: {
 *     "supervisor.router.decided": ({ next }) => console.log("->", next),
 *   },
 * });
 */
export type SupervisorExecuteOptions = {
  /**
   * Caller-chosen run identifier — reused as the cache key when
   * `store` is configured. Auto-generated (`sup_<rand>`) when omitted.
   */
  runId?: string;
  /**
   * Cancellation handle. Between-iteration cancellation is
   * guaranteed; mid-iteration aborts are propagated into every
   * in-flight child `execute()` (agents, workflows, router).
   */
  signal?: AbortSignal;
  /**
   * Per-execution event handlers — tier 3 of the 3-tier model.
   * Fire last, after definition-level and instance-level listeners.
   */
  on?: SupervisorEventHandlers;
  /**
   * Read-only request-scoped bag, surfaced on every `ctx.context`
   * inside `route` / `evaluate` / intent callbacks / router-entry
   * `placeholders` + `input` / per-intent `placeholders` + `input` +
   * `next`. Use it to thread per-request data — `userId`, `traceId`,
   * locale, DB clients, feature flags — without forcing supervisors
   * to be re-instantiated per request.
   *
   * Shallow-copied + frozen at intake, so callbacks can't mutate the
   * caller's object. NOT persisted in snapshots; re-supply on
   * `resume(runId, { context })`.
   */
  context?: Record<string, unknown>;
  /**
   * Prior conversation messages — read-only context threaded into
   * `route` / `evaluate` / dispatch callbacks via `ctx.history`, and
   * forwarded verbatim to every dispatched agent (and the receptionist
   * `ack` agent, when configured) as `agent.execute(input, { history })`.
   *
   * Mirrors `AgentExecuteOptions.history` so a supervisor can be slotted
   * into a chat pipeline as a drop-in replacement for a single agent
   * without the caller juggling history across primitives.
   *
   * NOT persisted in snapshots — re-supply on `resume(runId, { history })`
   * if the resumed run still needs prior conversation context.
   */
  history?: Message[];
  /**
   * Opaque caller-supplied identifier that groups multiple `execute()`
   * calls into one conceptual user session / request. Mirrored onto
   * every report node this run produces so flat dashboard queries
   * don't need to walk the tree.
   *
   * Auto-propagated to every dispatched intent, the router, the
   * receptionist `ack`, and any nested composite invoked through
   * `asTool`. Execution state stays isolated; only observability
   * identity is shared.
   */
  sessionId?: string;
};

/**
 * Options accepted by `supervisor.resume(runId, options?)`.
 *
 * `force: true` bypasses the signature drift check — use only when
 * you have verified that the definition change is safe for the
 * in-flight snapshot. `SupervisorDriftError` is otherwise thrown
 * without executing anything.
 */
export type SupervisorResumeOptions = SupervisorExecuteOptions & {
  force?: boolean;
};
