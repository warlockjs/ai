import { AIError, type AIErrorOptions } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";

/**
 * Payload passed to `ToolExecutionError` — identifies which tool
 * failed and, when applicable, which trip it was dispatched from.
 */
export type ToolExecutionErrorOptions = AIErrorOptions & {
  toolName: string;
  tripIndex?: number;
};

/**
 * A registered tool's `execute()` threw during dispatch — the tool
 * code itself failed (not its input schema). The model's request was
 * valid; the implementation crashed.
 *
 * Carries `toolName` so consumers can branch on which tool failed
 * without regex-parsing the message, and `tripIndex` to correlate
 * with the `LLMTrip` entry in `result.report.trips`.
 *
 * @example
 * if (result.error instanceof ToolExecutionError) {
 *   metrics.increment("tool.failure", { tool: result.error.toolName });
 * }
 */
export class ToolExecutionError extends AIError {
  public static readonly defaultCategory: ErrorCategory = "tool";

  public readonly toolName: string;
  public readonly tripIndex?: number;

  public constructor(message: string, options: ToolExecutionErrorOptions) {
    super("TOOL_EXEC_FAILED", message, options);
    this.name = "ToolExecutionError";
    this.toolName = options.toolName;
    this.tripIndex = options.tripIndex;
  }
}
