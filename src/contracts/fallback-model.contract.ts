import type { AIErrorCode } from "../errors/error-code.type";
import type { ModelContract } from "./model.contract";

/**
 * Predicate deciding whether a thrown error should advance the fallback
 * chain to the next model. Receives the original error verbatim (an
 * `AIError` subclass when the failure came from a provider adapter, or
 * any thrown value otherwise) and returns `true` to fall over, `false`
 * to re-throw immediately.
 *
 * @example
 * fallbackModel([primary, backup], {
 *   retryOn: (error) => error instanceof ProviderError,
 * });
 */
export type FallbackRetryPredicate = (error: unknown) => boolean;

/**
 * Tuning knobs for {@link fallbackModel}. Both forms of `retryOn` are
 * additive over the built-in transient-failure default (rate-limit,
 * timeout, and generic 5xx provider errors); omit it entirely to use
 * that default unchanged.
 */
export type FallbackModelOptions = {
  /**
   * Which failures advance the chain. Either an explicit allow-list of
   * stable {@link AIErrorCode} strings, or a predicate for arbitrary
   * branching. Absent = the built-in transient set
   * (`PROVIDER_RATE_LIMIT`, `PROVIDER_TIMEOUT`, `PROVIDER_ERROR`).
   *
   * Non-transient failures (auth, invalid-request, context-length,
   * content-filter) are NEVER retried by default — falling over on a
   * bad API key or an oversized prompt only burns the budget on every
   * downstream model, since the same input fails identically.
   */
  retryOn?: AIErrorCode[] | FallbackRetryPredicate;
};

/**
 * Diagnostic record of one model that the fallback chain tried and that
 * failed with a chain-advancing error. Exposed on the wrapper's
 * `lastAttempts` getter so callers can see exactly which providers were
 * burned before the chain produced a response (or re-threw the final
 * error).
 */
export type FallbackAttempt = {
  /** Model identifier that failed (`ModelContract.name`). */
  modelName: string;
  /** Provider the failed model belonged to (`ModelContract.provider`). */
  provider: string;
  /** The error that triggered the fall-over to the next model. */
  error: unknown;
};

/**
 * The `ModelContract` returned by `fallbackModel()`: a fully usable
 * model that additionally exposes which wrapped models failed (and why)
 * during the most recent call.
 */
export interface FallbackModelContract extends ModelContract {
  /**
   * Models that failed with a chain-advancing error during the most
   * recent `complete()` / `stream()` call, in attempt order. Empty when
   * the primary model succeeded outright. Overwritten on each call.
   */
  readonly lastAttempts: FallbackAttempt[];
}
