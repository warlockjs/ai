import { AIError, type AIErrorOptions } from "./ai-error";
import type { AIErrorCode } from "./error-code.type";

/**
 * Base class for all workflow-specific failures. Subclasses carry
 * precise codes; this base catches everything `workflow.execute()`
 * can produce beyond agent/tool/provider errors.
 */
export class WorkflowError extends AIError {
  public constructor(
    message: string,
    options?: AIErrorOptions,
    code: AIErrorCode = "WORKFLOW_ERROR",
  ) {
    super(code, message, options);
    this.name = "WorkflowError";
  }
}
