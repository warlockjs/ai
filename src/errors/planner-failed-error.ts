import { AIError, type AIErrorOptions } from "./ai-error";
import type { AIErrorCode } from "./error-code.type";
import type { ErrorCategory } from "./error-category.type";

/**
 * Base class for every planner-specific failure surfaced from
 * `planner.execute()` or thrown at authoring-time by `ai.planner()`
 * validation.
 *
 * **Role.** Anchor for the `PLANNER_*` code family. Subclasses carry
 * precise codes (`PLANNER_PLAN_INVALID`, `PLANNER_CANCELLED`); this base
 * catches everything a planning run can produce that isn't already an
 * agent / tool / workflow / supervisor error bubbling up from a
 * dispatched capability.
 *
 * Child-execution errors (agent, tool, provider, workflow) flow through
 * the planner unchanged — they are captured on the relevant step
 * snapshot and surfaced on `result.error` directly, never re-wrapped.
 *
 * @example
 * const result = await planner.execute("Research and summarize X");
 * if (result.error instanceof PlannerFailedError) {
 *   console.error(result.error.code, result.error.message);
 * }
 */
export class PlannerFailedError extends AIError {
  /**
   * Generic planner failures (authoring-time config violations, the
   * `toAIError` catch-all for unexpected runtime crashes during a run)
   * are orchestration-level provider failures. Subclasses with a more
   * precise meaning redeclare their own — `PlannerPlanInvalidError` is
   * `"schema"`, `PlannerCancelledError` is `"cancelled"`.
   */
  public static readonly defaultCategory: ErrorCategory = "provider";

  public constructor(
    message: string,
    options?: AIErrorOptions,
    code: AIErrorCode = "PLANNER_FAILED",
  ) {
    super(code, message, options);
    this.name = "PlannerFailedError";
  }
}
