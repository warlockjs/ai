import type { AIErrorOptions } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";
import { WorkflowError } from "./workflow-error";

export type WorkflowDriftErrorOptions = AIErrorOptions & {
  savedSignature: string;
  currentSignature: string;
  runId: string;
};

/**
 * `workflow.resume(runId)` found a snapshot whose structural signature
 * doesn't match the current workflow definition. Thrown without
 * executing anything. User must discard, force, or migrate manually.
 */
export class WorkflowDriftError extends WorkflowError {
  public static readonly defaultCategory: ErrorCategory = "drift";

  public readonly savedSignature: string;
  public readonly currentSignature: string;
  public readonly runId: string;

  public constructor(message: string, options: WorkflowDriftErrorOptions) {
    super(message, options, "WORKFLOW_DRIFT");
    this.name = "WorkflowDriftError";
    this.savedSignature = options.savedSignature;
    this.currentSignature = options.currentSignature;
    this.runId = options.runId;
  }
}
