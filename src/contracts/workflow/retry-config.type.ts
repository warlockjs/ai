/**
 * Backoff strategy for step retries.
 *
 * - `"none"` — immediate retry, no delay
 * - `"linear"` — attempt N waits `N * 500ms` (capped at 30s)
 * - `"exponential"` — 500ms, 1s, 2s, 4s, ... (capped at 30s)
 * - custom `(attempt) => ms` — full control (attempt is 1-based)
 */
export type RetryBackoff =
  | "none"
  | "linear"
  | "exponential"
  | ((attempt: number) => number);

export type RetryConfig = {
  /** Total attempts including the first. Default 1 (no retry). */
  attempts: number;
  /** Backoff strategy between attempts. Default `"exponential"`. */
  backoff?: RetryBackoff;
  /** Per-error predicate; return false to skip remaining attempts. */
  retryOn?: (error: unknown, attempt: number) => boolean;
  /** Hook fired before each retry (not the first attempt). */
  onRetry?: (attempt: number, error: unknown) => void;
};
