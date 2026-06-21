import type { StandardSchemaV1 } from "@standard-schema/spec";
import { AIError, type AIErrorOptions } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";

/**
 * Payload passed to `SchemaValidationError`. Subset of
 * `AIErrorOptions` plus the machine-readable validation issues list.
 */
export type SchemaValidationErrorOptions = AIErrorOptions & {
  issues?: readonly StandardSchemaV1.Issue[];
};

/**
 * A `StandardSchemaV1` validation call returned issues, or the input
 * was not valid JSON before validation could even run.
 *
 * Produced in two places today:
 * - Agent output parsing — the final trip text failed `JSON.parse` or
 *   the parsed value failed `~standard.validate`.
 * - Tool input validation — the model's raw arguments for a tool call
 *   didn't match the tool's `input` schema.
 *
 * `issues` carries the structured validation result when available so
 * consumers can present per-field feedback.
 *
 * @example
 * if (result.error instanceof SchemaValidationError) {
 *   for (const issue of result.error.issues ?? []) {
 *     console.warn(issue.path, issue.message);
 *   }
 * }
 */
export class SchemaValidationError extends AIError {
  public static readonly defaultCategory: ErrorCategory = "schema";

  public readonly issues?: readonly StandardSchemaV1.Issue[];

  public constructor(message: string, options?: SchemaValidationErrorOptions) {
    super("SCHEMA_VALIDATION_FAILED", message, options);
    this.name = "SchemaValidationError";
    this.issues = options?.issues;
  }
}
