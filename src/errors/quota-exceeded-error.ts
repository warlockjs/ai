import type { AIErrorOptions } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";
import { ProviderError } from "./provider-error";

/**
 * Provider refused the call because the account has exhausted its
 * paid quota (monthly credit, billing cap, subscription tier limit).
 *
 * **Not retryable.** Unlike `ProviderRateLimitError` — where the
 * bucket refills after `retryAfter` milliseconds — this one needs
 * human intervention: top up the account, upgrade the plan, or
 * switch to a different key. Consumers who blindly back-off-and-retry
 * on rate-limit errors would loop forever here, which is why the two
 * are split.
 *
 * Typically surfaced as OpenAI `code: "insufficient_quota"`.
 *
 * **Distinct from `BudgetExceededError`.** `QuotaExceededError` is
 * the *provider* telling us their billing cap is hit.
 * `BudgetExceededError` is our *own* middleware enforcing a
 * user-configured ceiling client-side.
 *
 * @example
 * if (result.error instanceof QuotaExceededError) {
 *   await pagerDuty.trigger("openai quota exhausted");
 *   return fallbackResponse();
 * }
 */
export class QuotaExceededError extends ProviderError {
  public static readonly defaultCategory: ErrorCategory = "quota";

  public constructor(message: string, options?: AIErrorOptions) {
    super(message, options, "PROVIDER_QUOTA_EXCEEDED");
    this.name = "QuotaExceededError";
  }
}
