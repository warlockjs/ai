import { AIError, type AIErrorOptions } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";

/**
 * Unit of the budget being enforced. `tokens` for context/output
 * caps, `usd` for monetary caps, `requests` for call-count caps.
 */
export type BudgetUnit = "tokens" | "usd" | "requests";

/**
 * Payload for `BudgetExceededError`. All three fields are required so
 * consumers can present the breach numerically without having to
 * reparse the message.
 */
export type BudgetExceededErrorOptions = AIErrorOptions & {
  limit: number;
  actual: number;
  unit: BudgetUnit;
};

/**
 * A user- or framework-configured budget was exceeded mid-execution.
 *
 * **Not thrown yet.** The class is defined here so v2's budget
 * middleware can throw it without a breaking release of the error
 * hierarchy. Shape is locked: `{ limit, actual, unit }`.
 *
 * @example
 * if (error instanceof BudgetExceededError && error.unit === "usd") {
 *   alertFinance(error.actual, error.limit);
 * }
 */
export class BudgetExceededError extends AIError {
  public static readonly defaultCategory: ErrorCategory = "budget";

  public readonly limit: number;
  public readonly actual: number;
  public readonly unit: BudgetUnit;

  public constructor(message: string, options: BudgetExceededErrorOptions) {
    super("BUDGET_EXCEEDED", message, options);
    this.name = "BudgetExceededError";
    this.limit = options.limit;
    this.actual = options.actual;
    this.unit = options.unit;
  }
}
