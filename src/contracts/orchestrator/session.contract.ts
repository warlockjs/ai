import type { SessionSendResult } from "../result/session-send-result.type";

/**
 * A stateful session that routes messages through agents, workflows, or
 * supervisors.
 *
 * @deprecated Obsolete v2 forward-declaration. The locked v1
 * orchestrator (design §15) has NO stateful session object and no
 * `send()` method. A turn is run via
 * `orchestrator.execute(input, { sessionId, history })`, which returns
 * an {@link OrchestratorResult} — see
 * `../result/orchestrator-result.type`. Retained unchanged for one
 * minor for non-breaking compatibility; do not use in new code.
 */
export interface SessionContract {
  /**
   * Send a message to the session and receive a result.
   *
   * @deprecated Use `orchestrator.execute(input, options)` instead.
   */
  send(message: string): Promise<SessionSendResult>;
}
