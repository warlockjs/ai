import { AIError, type AIErrorOptions } from "../errors/ai-error";
import type { ErrorCategory } from "../errors/error-category.type";

/**
 * A prompt name was looked up in the registry but is not registered.
 *
 * Thrown by `resolve(name, …)` and `versions(name)` on an unknown name —
 * closing the silent first-match / empty-result gap a bare `Map.get` would
 * leave. The missing name is carried in `context.name` for logging.
 *
 * Reuses the `"validation"` category (an authoring-time lookup mistake, not a
 * provider failure) and the shared `PROVIDER_INVALID_REQUEST` code, since the
 * prompt registry is a local primitive with no dedicated error code.
 *
 * @example
 * try {
 *   prompts.resolve("unknown-agent");
 * } catch (error) {
 *   if (error instanceof PromptNotFoundError) {
 *     console.error(error.context?.name);
 *   }
 * }
 */
export class PromptNotFoundError extends AIError {
  public static readonly defaultCategory: ErrorCategory = "validation";

  public constructor(name: string, options?: AIErrorOptions) {
    super("PROVIDER_INVALID_REQUEST", `Prompt "${name}" is not registered.`, {
      ...options,
      context: { name, ...options?.context },
    });
    this.name = "PromptNotFoundError";
  }
}

/**
 * A prompt-registry authoring or resolution invariant was violated:
 *
 * - `add(name, version)` / `register(entry)` with a duplicate version label
 *   (no silent overwrite).
 * - `resolve(name, …)` where the picked version declares `required` keys that
 *   are missing from the merged placeholders (the missing keys are listed in
 *   the message and carried on `context.missing`).
 *
 * Reuses the `"validation"` category and the shared `SCHEMA_VALIDATION_FAILED`
 * code — it is the same class of "you supplied something the registry can't
 * use" failure as a schema-validation miss.
 *
 * @example
 * try {
 *   prompts.resolve("support-agent", { placeholders: {} });
 * } catch (error) {
 *   if (error instanceof PromptValidationError) {
 *     console.error(error.context?.missing); // ["product"]
 *   }
 * }
 */
export class PromptValidationError extends AIError {
  public static readonly defaultCategory: ErrorCategory = "validation";

  public constructor(message: string, options?: AIErrorOptions) {
    super("SCHEMA_VALIDATION_FAILED", message, options);
    this.name = "PromptValidationError";
  }
}
