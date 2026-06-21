import type { AIErrorOptions } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";
import { ProviderError } from "./provider-error";

/**
 * Payload for `ProviderRateLimitError`. `retryAfter` is the server's
 * hint (typically parsed from the `Retry-After` header) in milliseconds.
 */
export type ProviderRateLimitErrorOptions = AIErrorOptions & {
  retryAfter?: number;
};

/**
 * Provider refused the call because the account (or key, or window)
 * is over its rate-limit or quota. Retryable after `retryAfter`
 * milliseconds — consumers are expected to back off before retrying.
 *
 * Covers both transient `429 Too Many Requests` and the billing-level
 * `insufficient_quota` case; the adapter decides which provider
 * signals map here.
 *
 * @example
 * if (result.error instanceof ProviderRateLimitError) {
 *   await sleep(result.error.retryAfter ?? 1000);
 * }
 */
export class ProviderRateLimitError extends ProviderError {
  public static readonly defaultCategory: ErrorCategory = "rate-limit";

  public readonly retryAfter?: number;

  public constructor(message: string, options?: ProviderRateLimitErrorOptions) {
    super(message, options, "PROVIDER_RATE_LIMIT");
    this.name = "ProviderRateLimitError";
    this.retryAfter = options?.retryAfter;
  }
}
