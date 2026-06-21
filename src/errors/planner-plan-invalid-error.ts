import type { AIErrorOptions } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";
import { PlannerFailedError } from "./planner-failed-error";

/**
 * The planner asked the LLM for an execution plan but the response
 * could not be parsed / validated into a usable {@link PlannerPlan},
 * or it referenced a capability that was never registered.
 *
 * Surfaced on `result.error` with `report.status === "failed"` — the
 * planner returns normally rather than throwing, so callers branch on
 * the typed envelope like every other primitive.
 */
export class PlannerPlanInvalidError extends PlannerFailedError {
  public static readonly defaultCategory: ErrorCategory = "schema";

  public constructor(message: string, options?: AIErrorOptions) {
    super(message, options, "PLANNER_PLAN_INVALID");
    this.name = "PlannerPlanInvalidError";
  }
}
