import type { AIErrorOptions } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";
import { WorkflowError } from "./workflow-error";

export type WorkflowCancelledErrorOptions = AIErrorOptions & {
  cancelledAt: string;
  reason?: string;
};

/**
 * Workflow was cancelled via `AbortSignal` before it could finish.
 * `cancelledAt` is ISO timestamp at abort; `reason` carries the
 * `controller.abort(reason)` payload when provided.
 */
export class WorkflowCancelledError extends WorkflowError {
  public static readonly defaultCategory: ErrorCategory = "cancelled";

  public readonly cancelledAt: string;
  public readonly reason?: string;

  public constructor(message: string, options: WorkflowCancelledErrorOptions) {
    super(message, options, "WORKFLOW_CANCELLED");
    this.name = "WorkflowCancelledError";
    this.cancelledAt = options.cancelledAt;
    this.reason = options.reason;
  }
}
