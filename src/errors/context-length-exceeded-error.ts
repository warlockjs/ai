import type { AIErrorOptions } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";
import { ProviderError } from "./provider-error";

/**
 * Payload for `ContextLengthExceededError`. All fields are optional —
 * providers inconsistently surface exact token counts and the
 * model's limit. When present, they let callers compute a trim
 * target; when absent, the error still categorizes the failure.
 */
export type ContextLengthExceededErrorOptions = AIErrorOptions & {
  limit?: number;
  actual?: number;
  modelName?: string;
};

/**
 * The request's prompt (messages + tools + schema) exceeded the
 * model's context window. Not retryable without shortening the input.
 *
 * Typically surfaced as OpenAI 400 with `code: "context_length_exceeded"`.
 *
 * @example
 * if (result.error instanceof ContextLengthExceededError) {
 *   messages = truncateOldestTurns(messages);
 *   return agent.execute(input, { history: messages });
 * }
 */
export class ContextLengthExceededError extends ProviderError {
  public static readonly defaultCategory: ErrorCategory = "context-length";

  public readonly limit?: number;
  public readonly actual?: number;
  public readonly modelName?: string;

  public constructor(
    message: string,
    options?: ContextLengthExceededErrorOptions,
  ) {
    super(message, options, "CONTEXT_LENGTH_EXCEEDED");
    this.name = "ContextLengthExceededError";
    this.limit = options?.limit;
    this.actual = options?.actual;
    this.modelName = options?.modelName;
  }
}
