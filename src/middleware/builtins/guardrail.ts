import type {
  AgentMiddleware,
  MiddlewareTripContext,
} from "../../contracts/middleware";
import type { ModelResponse } from "../../contracts/model.contract";
import { GuardrailViolationError } from "../../errors";
import { extractUserText } from "../utils";

/**
 * Decision returned by a guardrail check function. `ok: true`
 * permits the call; `ok: false` rejects with a human-readable
 * `reason` surfaced on `GuardrailViolationError`.
 */
export type GuardrailCheckResult = { ok: true } | { ok: false; reason: string };

/**
 * Synchronous or asynchronous check invoked against the outbound
 * prompt (`inputCheck`) or the inbound response (`outputCheck`).
 * Receives the raw text and the surrounding trip context so
 * consumers can classify, route to an external moderation API, or
 * branch on tripIndex / messages history.
 */
export type GuardrailCheck = (
  text: string,
  context: MiddlewareTripContext,
) => GuardrailCheckResult | Promise<GuardrailCheckResult>;

/**
 * Configuration for `guardrail()`.  At least one of `inputCheck` or
 * `outputCheck` must be supplied — a guardrail with no checks is a
 * no-op.
 */
export type GuardrailOptions = {
  /**
   * Run against the outbound prompt just before the model sees it.
   * Fires every trip with the concatenated last user-message text.
   * Rejection aborts the trip with a `GuardrailViolationError` whose
   * `phase === "input"`.
   */
  inputCheck?: GuardrailCheck;
  /**
   * Run against the model's response text after the trip completes.
   * Fires every trip with `response.content`. Rejection aborts with
   * a `GuardrailViolationError` whose `phase === "output"`.
   *
   * Output checks run BEFORE any tool dispatch — a rejected response
   * means the tool calls it requested are never invoked.
   */
  outputCheck?: GuardrailCheck;
  /**
   * Override the middleware name — surfaces on
   * `GuardrailViolationError.guardrail` so operators can tell two
   * guardrails apart in logs. Default `"guardrail"`.
   */
  name?: string;
};

/**
 * Pre/post content guardrail for an agent run.
 *
 * **Role.** Inspects outbound prompts and inbound responses against
 * caller-supplied policies, aborting the trip with a typed
 * `GuardrailViolationError` when either trips a check. Consumers
 * distinguish `"input"` vs `"output"` violations off `error.phase`
 * — the two failure modes have very different product responses
 * (block the user vs re-prompt the model).
 *
 * **Scope.** Per-trip. Fires on every round-trip the agent makes,
 * including repair attempts and tool-follow-up trips. Input checks
 * evaluate the last user-role message; output checks evaluate the
 * raw model response text before any tool call is dispatched.
 *
 * **Composition.** A single middleware instance can carry both
 * `inputCheck` and `outputCheck`, or two separate instances can be
 * registered (useful when input and output policies come from
 * different teams / services). Registration order determines which
 * guardrail's violation surfaces first — the short-circuit throws
 * from the innermost offending hook, and outer guardrails never run
 * after an abort.
 *
 * **Not a sanitizer.** The guardrail either passes a trip unchanged
 * or aborts it. Mutating the prompt / response in-place is out of
 * scope — use a bespoke middleware for content rewriting.
 *
 * @example
 * const policy = guardrail({
 *   inputCheck: async (text) =>
 *     text.includes("SSN") ? { ok: false, reason: "pii" } : { ok: true },
 *   outputCheck: async (text) =>
 *     text.length > 10_000 ? { ok: false, reason: "too-long" } : { ok: true },
 * });
 *
 * const myAgent = agent({ model, middleware: [policy] });
 */
export function guardrail(options: GuardrailOptions): AgentMiddleware {
  const name = options.name ?? "guardrail";
  const { inputCheck, outputCheck } = options;

  return {
    name,
    trip: {
      async before(context) {
        if (!inputCheck) {
          return;
        }

        const prompt = extractUserText(context.messages);

        if (!prompt) {
          return;
        }

        const verdict = await inputCheck(prompt, context);

        if (!verdict.ok) {
          throw new GuardrailViolationError(
            `guardrail "${name}" rejected input — ${verdict.reason}`,
            { phase: "input", reason: verdict.reason, guardrail: name },
          );
        }
      },
      async after(context, response: ModelResponse) {
        if (!outputCheck) {
          return;
        }

        if (!response.content) {
          return;
        }

        const verdict = await outputCheck(response.content, context);

        if (!verdict.ok) {
          throw new GuardrailViolationError(
            `guardrail "${name}" rejected output — ${verdict.reason}`,
            { phase: "output", reason: verdict.reason, guardrail: name },
          );
        }
      },
    },
  };
}
