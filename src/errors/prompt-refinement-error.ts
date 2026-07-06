import type { AIErrorOptions } from "./ai-error";
import { AIError } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";

/**
 * Why a prompt refinement was rejected:
 *
 * - `"model"` — the refiner model call itself failed (provider error, no
 *   key, timeout); the underlying `AIError` rides on `cause`.
 * - `"parity"` — the rewrite broke placeholder parity (added, removed, or
 *   renamed a `{{placeholder}}` / changed its `|default`) and one repair
 *   attempt didn't fix it; the offending tokens are listed in `context.issues`.
 * - `"empty"` — the refiner returned no usable text.
 */
export type PromptRefinementFailureReason = "model" | "parity" | "empty";

export type PromptRefinementErrorOptions = AIErrorOptions & {
  reason: PromptRefinementFailureReason;
};

/**
 * An explicit `refine()` / `refinePrompt()` call could not produce an
 * acceptable compiled prompt. Thrown (not degraded) because the explicit
 * compilation surface is used by routes, warmup, and CI — callers there need
 * the failure, not a silently-served original.
 *
 * The LAZY agent path never sees this error: `materialize()` catches it,
 * warns once, and serves the original prompt text — refinement is advisory
 * there, mirroring the Nova-safe judge policy in `ai.prompts.validate`.
 */
export class PromptRefinementError extends AIError {
  public static readonly defaultCategory: ErrorCategory = "validation";

  public readonly reason: PromptRefinementFailureReason;

  public constructor(message: string, options: PromptRefinementErrorOptions) {
    super("PROMPT_REFINEMENT_FAILED", message, options);
    this.name = "PromptRefinementError";
    this.reason = options.reason;
  }
}
