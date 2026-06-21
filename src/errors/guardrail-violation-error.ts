import { AIError, type AIErrorOptions } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";

/**
 * Phase at which a guardrail rejected the content — `"input"` when the
 * violation was detected on the outbound prompt (before the model saw
 * it), `"output"` when it was detected on the model's response (before
 * the caller saw it).
 */
export type GuardrailPhase = "input" | "output";

/**
 * Payload for `GuardrailViolationError`. `phase` tells the caller
 * whether the prompt or the response tripped the check; `reason` is
 * the free-form explanation the guardrail middleware produced;
 * `guardrail` names the offending middleware so operators can tune a
 * specific rule without hunting through logs.
 */
export type GuardrailViolationErrorOptions = AIErrorOptions & {
  phase: GuardrailPhase;
  reason: string;
  guardrail?: string;
};

/**
 * A guardrail middleware rejected the prompt or response mid-execution.
 *
 * **Role.** The typed abort surface for `ai.middleware.guardrail`.
 * Consumers branch on `error.phase` to distinguish "the user asked
 * something disallowed" (`"input"`) from "the model produced something
 * disallowed" (`"output"`) — the two failure modes have very different
 * product responses (block vs. retry, or surface a policy message vs.
 * re-prompt the model).
 *
 * Thrown from inside the middleware pipeline's `trip.before` / `trip.after`
 * hooks; surfaced to the caller via `result.error` like every other
 * `AIError`.
 *
 * @example
 * if (result.error instanceof GuardrailViolationError) {
 *   if (result.error.phase === "input") {
 *     return respondWithPolicyMessage(result.error.reason);
 *   }
 *   return retryWithSanitizedPrompt();
 * }
 */
export class GuardrailViolationError extends AIError {
  public static readonly defaultCategory: ErrorCategory = "guardrail";

  public readonly phase: GuardrailPhase;
  public readonly reason: string;
  public readonly guardrail?: string;

  public constructor(message: string, options: GuardrailViolationErrorOptions) {
    super("GUARDRAIL_VIOLATION", message, options);

    this.name = "GuardrailViolationError";
    this.phase = options.phase;
    this.reason = options.reason;
    this.guardrail = options.guardrail;
  }
}
