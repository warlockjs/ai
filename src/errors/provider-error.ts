import { AIError, type AIErrorOptions } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";
import type { AIErrorCode } from "./error-code.type";

/**
 * Any failure that originated from the model provider (OpenAI, Azure,
 * OpenRouter, local gateway). Base class for the provider subclasses
 * below — raw provider errors caught in an adapter are always wrapped
 * into *some* `ProviderError` so downstream code can branch on
 * `instanceof ProviderError` when any provider-side failure will do.
 *
 * **Subclasses (more specific first).**
 * - `ProviderRateLimitError` — 429 / rate-limit / quota exhaustion.
 * - `ProviderTimeoutError` — connection or request timeout.
 * - `ContextLengthExceededError` — prompt exceeded the model window.
 * - `ContentFilterError` — response blocked by provider safety policy.
 * - `ProviderAuthError` — bad / expired API key.
 * - `InvalidRequestError` — catch-all 4xx not covered above.
 *
 * When no subclass fits (e.g. 5xx server error, unknown network
 * failure), adapters throw plain `ProviderError` with the raw payload
 * captured in `context`.
 *
 * @example
 * if (result.error instanceof ProviderError) {
 *   if (result.error instanceof ProviderRateLimitError) {
 *     return retryAfter(result.error.retryAfter ?? 1000);
 *   }
 * }
 */
export class ProviderError extends AIError {
  public static readonly defaultCategory: ErrorCategory = "provider";

  public constructor(
    message: string,
    options?: AIErrorOptions,
    code: AIErrorCode = "PROVIDER_ERROR",
  ) {
    super(code, message, options);
    this.name = "ProviderError";
  }
}
