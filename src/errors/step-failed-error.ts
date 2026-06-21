import type { AIErrorOptions } from "./ai-error";
import { WorkflowError } from "./workflow-error";

export type StepFailedErrorOptions = AIErrorOptions & {
  stepName: string;
  attempts: number;
};

/**
 * A workflow step exhausted its retries (or was not retried) and
 * terminated with an error. `cause` carries the last underlying error.
 */
export class StepFailedError extends WorkflowError {
  public readonly stepName: string;
  public readonly attempts: number;

  public constructor(message: string, options: StepFailedErrorOptions) {
    super(message, options, "STEP_FAILED");
    this.name = "StepFailedError";
    this.stepName = options.stepName;
    this.attempts = options.attempts;
  }
}
