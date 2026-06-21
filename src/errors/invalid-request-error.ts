import type { AIErrorOptions } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";
import { ProviderError } from "./provider-error";

/**
 * Provider rejected the request as malformed — bad model name,
 * unsupported feature, missing required field, image attached to a
 * non-vision model, etc. The catch-all for 4xx responses that aren't
 * auth, rate-limit, context-length, or content-filter.
 *
 * Also thrown from the agent when user-side validation fails at the
 * boundary (e.g. vision gate, malformed attachment shape) — the
 * category is "you sent something the provider / agent cannot use".
 *
 * @example
 * if (result.error instanceof InvalidRequestError) {
 *   logger.error("bad agent input", { context: result.error.context });
 * }
 */
export class InvalidRequestError extends ProviderError {
  public static readonly defaultCategory: ErrorCategory = "validation";

  public constructor(message: string, options?: AIErrorOptions) {
    super(message, options, "PROVIDER_INVALID_REQUEST");
    this.name = "InvalidRequestError";
  }
}
