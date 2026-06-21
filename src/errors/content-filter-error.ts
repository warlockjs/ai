import type { AIErrorOptions } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";
import { ProviderError } from "./provider-error";

/**
 * Payload for `ContentFilterError`. Both fields optional — providers
 * don't consistently disclose the specific filter reason or
 * categories, especially when the block is pre-generation.
 */
export type ContentFilterErrorOptions = AIErrorOptions & {
  reason?: string;
  categories?: string[];
};

/**
 * Response (or request) was blocked by the provider's safety filter.
 * Not retryable with the same input — reshape the prompt or lean on
 * a less-restrictive model.
 *
 * @example
 * if (result.error instanceof ContentFilterError) {
 *   return respondWithPolicyMessage(result.error.reason);
 * }
 */
export class ContentFilterError extends ProviderError {
  public static readonly defaultCategory: ErrorCategory = "content-filter";

  public readonly reason?: string;
  public readonly categories?: string[];

  public constructor(message: string, options?: ContentFilterErrorOptions) {
    super(message, options, "CONTENT_FILTER");
    this.name = "ContentFilterError";
    this.reason = options?.reason;
    this.categories = options?.categories;
  }
}
