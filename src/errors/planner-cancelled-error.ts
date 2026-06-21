import type { AIErrorOptions } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";
import { PlannerFailedError } from "./planner-failed-error";

/**
 * Options for {@link PlannerCancelledError}. Carries the observation
 * timestamp and the optional `controller.abort(reason)` payload.
 */
export type PlannerCancelledErrorOptions = AIErrorOptions & {
  /** ISO-8601 timestamp at which the abort was observed by the planner. */
  cancelledAt: string;
  /** `controller.abort(reason)` payload when the caller supplied one. */
  reason?: string;
};

/**
 * Planner run was cancelled via `AbortSignal` before it could finish.
 * Between-step cancellation is guaranteed; mid-step cancellation is
 * best-effort (the signal is threaded into every in-flight capability
 * `execute()` call, but effectiveness depends on the child primitive
 * respecting it).
 *
 * On cancellation the planner returns normally with
 * `report.status === "cancelled"` and the partial step snapshots — the
 * error is placed on `result.error` rather than thrown.
 */
export class PlannerCancelledError extends PlannerFailedError {
  public static readonly defaultCategory: ErrorCategory = "cancelled";

  public readonly cancelledAt: string;
  public readonly reason?: string;

  public constructor(message: string, options: PlannerCancelledErrorOptions) {
    super(message, options, "PLANNER_CANCELLED");
    this.name = "PlannerCancelledError";
    this.cancelledAt = options.cancelledAt;
    this.reason = options.reason;
  }
}
