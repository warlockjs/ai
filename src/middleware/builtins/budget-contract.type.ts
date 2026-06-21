import type { MiddlewareExecuteContext } from "../../contracts/middleware";

/**
 * Which SLO dimension of a {@link BudgetContract} a breach belongs to.
 *
 * Distinct from `BudgetUnit` (`"tokens" | "usd" | "requests"`) on the
 * error: `BudgetUnit` is the measurement unit, `BudgetContractDimension`
 * is the *contract clause* that tripped. They line up for tokens / cost
 * but diverge for latency — which has no `BudgetUnit` of its own, so a
 * latency breach surfaces its authoritative detail through the error's
 * `context.dimension` rather than `error.unit`.
 */
export type BudgetContractDimension = "tokens" | "cost" | "latency";

/**
 * What the middleware does when a {@link BudgetContract} clause is
 * breached.
 *
 * - `"abort"` — throw `BudgetExceededError`, stopping the run at the
 *   next trip boundary (`result.error` is populated; `execute()` itself
 *   still never throws). The same hard-stop semantics as the legacy
 *   `onExceeded: "abort"` path.
 * - `"fallback"` — do NOT abort. Record a typed {@link BudgetContractViolation}
 *   signal in the middleware state bag (read it back with
 *   `readBudgetFallbackSignal`) and invoke the optional `fallback`
 *   callback, then let the run continue. The middleware cannot itself
 *   swap models, so a fallback orchestrator / outer layer reads the
 *   signal and decides how to degrade (cheaper model, cached answer,
 *   truncated context).
 */
export type BudgetContractViolationMode = "abort" | "fallback";

/**
 * A single recorded breach of a {@link BudgetContract} clause. Captured
 * verbatim so a fallback layer can branch on the exact dimension and the
 * numbers that tripped it without re-parsing a message string.
 *
 * `limit` and `actual` share the dimension's natural unit: tokens for
 * `"tokens"`, USD for `"cost"`, milliseconds for `"latency"`.
 */
export type BudgetContractViolation = {
  /** Which contract clause tripped. */
  dimension: BudgetContractDimension;
  /** The configured cap for the breached dimension. */
  limit: number;
  /** The cumulative actual value at the moment of breach. */
  actual: number;
  /** Resolved behavior for this breach — mirrors the contract's `onViolation`. */
  mode: BudgetContractViolationMode;
};

/**
 * Callback fired once when a {@link BudgetContract} clause is breached
 * under `onViolation: "fallback"`. Receives the recorded violation plus
 * the run's `execute`-level context so the consumer can read agent /
 * model identity and the shared state bag.
 *
 * Purely a notification hook — its return value is ignored and it cannot
 * abort the run (throw a typed `AIError` from a guardrail / custom
 * middleware if a hard stop is required instead). Errors thrown here are
 * swallowed by the budget middleware so a misbehaving callback cannot
 * crash the run.
 */
export type BudgetContractFallback = (
  violation: BudgetContractViolation,
  context: MiddlewareExecuteContext,
) => void | Promise<void>;

/**
 * Declarative service-level objective for a single agent run, enforced
 * by the budget middleware on top of (and independently of) the legacy
 * `maxTokens` / `maxCostUSD` caps.
 *
 * **Role.** Lets a team express a run-level SLO — "this run must cost
 * under $0.05, finish under 8s, and burn under 40k tokens" — as data,
 * then pick one global reaction (`abort` hard, or `fallback` soft) for
 * any clause that trips. The contract is the cost/latency budget the
 * caller is willing to spend; breaching it is an operational event, not
 * a user error.
 *
 * **Clauses.** Every cap is optional; supply only the dimensions you
 * care about. A contract with no caps is inert. `maxCostUSD` still needs
 * a `pricing` entry on `budget()` for the running model — without one,
 * the cost clause silently degrades (tokens / latency clauses keep
 * enforcing).
 *
 * **Latency.** Wall-clock milliseconds measured from the first
 * `execute.before` to each `trip.after`. Has no `BudgetUnit`, so a
 * latency abort surfaces its numbers through the thrown error's
 * `context` (`{ dimension: "latency", limit, actual }`) rather than
 * `error.unit`.
 *
 * @example
 * const guard = budget({
 *   pricing: { "gpt-4o": { inputPer1K: 0.005, outputPer1K: 0.015 } },
 *   contract: {
 *     maxCostUSD: 0.05,
 *     maxLatencyMs: 8_000,
 *     maxTokens: 40_000,
 *     onViolation: "fallback",
 *     fallback: (violation) => routeToCheaperModel(violation.dimension),
 *   },
 * });
 */
export type BudgetContract = {
  /**
   * Cumulative total-token cap for the run. Independent of the
   * top-level `BudgetOptions.maxTokens`; whichever trips first wins.
   */
  maxTokens?: number;
  /**
   * Cumulative USD-cost cap for the run. Requires `BudgetOptions.pricing`
   * for the running model — degrades silently without it, same as the
   * legacy cost cap.
   */
  maxCostUSD?: number;
  /**
   * Wall-clock latency cap in milliseconds, measured from the run start
   * to each completed trip. Breached when cumulative elapsed time
   * exceeds the cap at a trip boundary.
   */
  maxLatencyMs?: number;
  /**
   * Reaction applied to every clause of this contract. Default
   * `"abort"`. `"fallback"` records a signal + fires `fallback` and
   * lets the run continue.
   */
  onViolation?: BudgetContractViolationMode;
  /**
   * Notification callback fired on the first breach under
   * `onViolation: "fallback"`. Ignored when `onViolation` is `"abort"`.
   */
  fallback?: BudgetContractFallback;
};
