import type {
  RetryBackoff,
  RetryConfig,
} from "../contracts/workflow/retry-config.type";

export const DEFAULT_BACKOFF_CAP_MS = 30_000;

export function resolveBackoff(
  attempt: number,
  backoff: RetryBackoff | undefined,
): number {
  const value = (() => {
    switch (backoff) {
      case "none":
        return 0;
      case "linear":
        return attempt * 500;
      case "exponential":
      case undefined:
        return 500 * 2 ** (attempt - 1);
      default:
        return backoff(attempt);
    }
  })();

  return Math.max(0, Math.min(value, DEFAULT_BACKOFF_CAP_MS));
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError";
}

/**
 * Resolve the effective retry config for a step, merging per-step and
 * workflow-level defaults. `retry: false` disables retries entirely.
 */
export function resolveRetryConfig(
  step: { retry?: RetryConfig | false } | undefined,
  workflowDefault: RetryConfig | false | undefined,
): RetryConfig {
  if (step?.retry === false) return { attempts: 1 };
  if (step?.retry) return step.retry;
  if (workflowDefault === false || workflowDefault === undefined) {
    return { attempts: 1 };
  }
  return workflowDefault;
}
