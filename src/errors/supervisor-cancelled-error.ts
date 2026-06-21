import type { AIErrorOptions } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";
import { SupervisorFailedError } from "./supervisor-failed-error";

export type SupervisorCancelledErrorOptions = AIErrorOptions & {
  /** ISO-8601 timestamp at which the abort was observed by the supervisor. */
  cancelledAt: string;
  /** `controller.abort(reason)` payload when the caller supplied one. */
  reason?: string;
};

/**
 * Supervisor run was cancelled via `AbortSignal` before it could
 * finish. Between-iteration cancellation is guaranteed; mid-iteration
 * cancellation is best-effort (the signal is also threaded into every
 * in-flight child `execute()` call, but effectiveness depends on the
 * child primitive respecting it).
 *
 * On cancellation the supervisor returns normally with `status:
 * "cancelled"` and partial `report.snapshots` — the error is placed
 * on `result.error` rather than thrown.
 */
export class SupervisorCancelledError extends SupervisorFailedError {
  public static readonly defaultCategory: ErrorCategory = "cancelled";

  public readonly cancelledAt: string;
  public readonly reason?: string;

  public constructor(
    message: string,
    options: SupervisorCancelledErrorOptions,
  ) {
    super(message, options, "SUPERVISOR_CANCELLED");
    this.name = "SupervisorCancelledError";
    this.cancelledAt = options.cancelledAt;
    this.reason = options.reason;
  }
}
