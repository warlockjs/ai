import type { AIErrorOptions } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";
import { WorkflowError } from "./workflow-error";

export type MaxStepsExceededErrorOptions = AIErrorOptions & {
  maxSteps: number;
};

/**
 * Runaway-loop hard guard: workflow executed more step transitions
 * than `maxSteps` allows. Terminates the workflow immediately.
 */
export class MaxStepsExceededError extends WorkflowError {
  public static readonly defaultCategory: ErrorCategory = "max-steps";

  public readonly maxSteps: number;

  public constructor(message: string, options: MaxStepsExceededErrorOptions) {
    super(message, options, "WORKFLOW_MAX_STEPS");
    this.name = "MaxStepsExceededError";
    this.maxSteps = options.maxSteps;
  }
}
