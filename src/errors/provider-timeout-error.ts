import type { AIErrorOptions } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";
import { ProviderError } from "./provider-error";

/**
 * Provider call timed out — either at the transport layer (socket
 * connection) or on the server side (request exceeded the provider's
 * processing deadline). Idempotent retries are usually safe.
 *
 * @example
 * if (result.error instanceof ProviderTimeoutError) {
 *   return retry();
 * }
 */
export class ProviderTimeoutError extends ProviderError {
  public static readonly defaultCategory: ErrorCategory = "timeout";

  public constructor(message: string, options?: AIErrorOptions) {
    super(message, options, "PROVIDER_TIMEOUT");
    this.name = "ProviderTimeoutError";
  }
}
