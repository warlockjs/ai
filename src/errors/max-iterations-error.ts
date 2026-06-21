import type { AIErrorOptions } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";
import { SupervisorFailedError } from "./supervisor-failed-error";

export type MaxIterationsErrorOptions = AIErrorOptions & {
  maxIterations: number;
};

/**
 * Hard-cap guard: the supervisor ran `maxIterations` loop turns
 * without reaching a terminal decision (`END`, `satisfied: true`, or
 * cancellation). Terminates the run immediately with a typed error on
 * `result.error` — partial per-iteration snapshots are still
 * available on `result.report.snapshots`.
 *
 * @example
 * const { error, report } = await supervisor.execute(input);
 * if (error?.code === "SUPERVISOR_MAX_ITERATIONS") {
 *   logger.warn("supervisor did not converge", {
 *     iterations: report.iterations,
 *   });
 * }
 */
export class MaxIterationsError extends SupervisorFailedError {
  public static readonly defaultCategory: ErrorCategory = "max-iterations";

  public readonly maxIterations: number;

  public constructor(message: string, options: MaxIterationsErrorOptions) {
    super(message, options, "SUPERVISOR_MAX_ITERATIONS");
    this.name = "MaxIterationsError";
    this.maxIterations = options.maxIterations;
  }
}
