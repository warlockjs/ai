import type { AIErrorOptions } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";
import { OrchestratorFailedError } from "./orchestrator-failed-error";

export type OrchestratorCancelledErrorOptions = AIErrorOptions & {
  /** ISO-8601 timestamp at which the abort was observed by the orchestrator. */
  cancelledAt: string;
  /** The session whose turn was cancelled. */
  sessionId: string;
  /** `controller.abort(reason)` payload when the caller supplied one. */
  reason?: string;
};

/**
 * A turn was cancelled via `AbortSignal` before it could settle
 * (orchestrator.md §17 — "mid-turn cancel"). The orchestrator returns
 * normally with `report.status: "cancelled"` and the error placed on
 * `result.error` rather than thrown; session state reverts to the
 * pre-turn checkpoint (the orchestrator does not persist a fresh row
 * for a cancelled turn — Q10).
 *
 * Mirrors `SupervisorCancelledError`, orchestrator scope. When an
 * `iterate: true` turn is cancelled mid-iteration, the underlying
 * `SupervisorCancelledError` rides on `cause`.
 */
export class OrchestratorCancelledError extends OrchestratorFailedError {
  public static readonly defaultCategory: ErrorCategory = "cancelled";

  public readonly cancelledAt: string;
  public readonly sessionId: string;
  public readonly reason?: string;

  public constructor(
    message: string,
    options: OrchestratorCancelledErrorOptions,
  ) {
    super(message, options, "ORCHESTRATOR_CANCELLED");
    this.name = "OrchestratorCancelledError";
    this.cancelledAt = options.cancelledAt;
    this.sessionId = options.sessionId;
    this.reason = options.reason;
  }
}
