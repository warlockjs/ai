import type { Message } from "../conversation-message.type";
import type { OrchestratorEventHandlers } from "./orchestrator-event.type";

/**
 * Per-call options for `orchestrator.execute(input, options)` (design
 * §15.4).
 *
 * `sessionId` names the session this turn acts on (no implicit "current
 * session" — §18.1). `history` is required in v1: the framework never
 * persists messages itself (Path 2 only, §7), so the dev passes the
 * prior turns each call. `state` is a partial seed/patch shallow-merged
 * into the loaded session state. `context` is the request-scoped bag,
 * frozen at intake.
 *
 * `TState` defaults to `Record<string, unknown>` so callers that don't
 * parameterize still get a usable `Partial<TState>` patch type.
 */
export type OrchestratorExecuteOptions<TState = Record<string, unknown>> = {
  /** Required — names the session this turn acts on. */
  sessionId: string;
  /** Required — prior conversation turns (Path 2; framework never persists). */
  history: Message[];
  /** Partial seed/patch shallow-merged into the loaded session state. */
  state?: Partial<TState>;
  /** Request-scoped bag — frozen + shallow-copied at intake. */
  context?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Per-call event handlers — tier 3 of the 3-tier model. */
  on?: OrchestratorEventHandlers;
  /** Bypass the drift check for this call. */
  force?: boolean;
};

/**
 * Options for `orchestrator.resume(sessionId, options)` (design §15.4).
 *
 * Resume re-supplies request-scoped `context` (NOT persisted — §9.1)
 * and rehydrates state from the checkpoint. No `history` field: a
 * resume continues an interrupted turn from its persisted snapshot
 * rather than opening a fresh turn.
 */
export type OrchestratorResumeOptions = {
  /** Request-scoped bag re-supplied for the resumed turn. */
  context?: Record<string, unknown>;
  signal?: AbortSignal;
  on?: OrchestratorEventHandlers;
  /** Bypass the drift check on resume. */
  force?: boolean;
};
