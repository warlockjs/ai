import type { EvaluateContext, EvaluateResult } from "../contracts/supervisor/evaluate-context.type";

/**
 * Build the `"quality"` gate — a review-then-fix `evaluate` callback.
 *
 * After each iteration's intents settle and merge into supervisor
 * `state`, the gate reads `state[gateKey]`. If truthy the run
 * terminates (`{ satisfied: true }`); otherwise it re-dispatches the
 * fixer with the reviewer feedback (`state[feedbackKey]`) threaded into
 * the next iteration's composed input. No termination or re-dispatch
 * code is written here — it leans entirely on the shipped
 * {@link EvaluateResult} semantics.
 *
 * @param gateKey - State key holding the reviewer verdict. Default `"approved"`.
 * @param fixerRole - Member key the gate reassigns to on rejection. Default `"fixer"`.
 * @param feedbackKey - State key holding reviewer feedback. Default `"notes"`.
 */
export function buildQualityGate<TState>(
  gateKey = "approved",
  fixerRole = "fixer",
  feedbackKey = "notes",
): (ctx: EvaluateContext<TState>) => EvaluateResult {
  return (ctx) => {
    const state = ctx.state as Record<string, unknown>;

    if (state[gateKey]) {
      return { satisfied: true };
    }

    return { reassignTo: fixerRole, feedback: String(state[feedbackKey] ?? "") };
  };
}

/**
 * Build the `"verify"` gate — a test-then-fix `evaluate` callback.
 *
 * Identical in shape to {@link buildQualityGate} but keyed on the
 * tester's pass/fail slice (`state[gateKey]`, default `"passed"`)
 * rather than a subjective reviewer score. On failure it re-dispatches
 * the fixer; there is no feedback channel for the pass/fail signal, so
 * none is threaded forward.
 *
 * @param gateKey - State key holding the pass/fail verdict. Default `"passed"`.
 * @param fixerRole - Member key the gate reassigns to on failure. Default `"fixer"`.
 */
export function buildVerifyGate<TState>(
  gateKey = "passed",
  fixerRole = "fixer",
): (ctx: EvaluateContext<TState>) => EvaluateResult {
  return (ctx) => {
    const state = ctx.state as Record<string, unknown>;

    if (state[gateKey]) {
      return { satisfied: true };
    }

    return { reassignTo: fixerRole };
  };
}
