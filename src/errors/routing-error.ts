import type { AIErrorOptions } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";
import { WorkflowError } from "./workflow-error";

export type RoutingErrorOptions = AIErrorOptions & {
  stepName: string;
  targetName?: string;
};

/**
 * `nextStep` returned an invalid `goto`, or the `nextStep` callback
 * itself threw. Routing is authoritative and has no recovery path —
 * the workflow terminates immediately.
 */
export class RoutingError extends WorkflowError {
  public static readonly defaultCategory: ErrorCategory = "routing";

  public readonly stepName: string;
  public readonly targetName?: string;

  public constructor(message: string, options: RoutingErrorOptions) {
    super(message, options, "WORKFLOW_INVALID_GOTO");
    this.name = "RoutingError";
    this.stepName = options.stepName;
    this.targetName = options.targetName;
  }
}
