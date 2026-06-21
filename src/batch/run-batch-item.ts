import type { BaseResult } from "../contracts/result/base-result.type";
import type { ExecutableContract } from "../contracts/executable.contract";
import type { RetryConfig } from "../contracts/workflow/retry-config.type";
import { isAbortError, resolveBackoff, resolveRetryConfig } from "../workflow/retry";
import { toAIError } from "../workflow/step-runner";
import type { BatchItemResult } from "./batch.type";

/**
 * Parameters for {@link runBatchItem}. Kept as a plain bag so the
 * concurrency pool can build it once per index without a long
 * positional argument list.
 */
export type RunBatchItemParams<TInput, TOptions, TResult extends BaseResult> = {
  index: number;
  input: TInput;
  executable: ExecutableContract<TInput, TOptions, TResult>;
  retry: RetryConfig | undefined;
  signal: AbortSignal | undefined;
};

/**
 * Sleep for `ms`, settling early (without throwing) if `signal`
 * aborts during the wait. The caller re-checks `signal.aborted` after
 * this resolves, so a silent early return is enough — we never want a
 * pending timer to keep the batch alive past cancellation.
 */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Execute one item with per-item retry, isolated so a failure can
 * neither throw nor disturb sibling items running in the same pool.
 *
 * Reuses the workflow retry vocabulary verbatim
 * ({@link resolveRetryConfig} / {@link resolveBackoff}) so batch and
 * workflow steps retry identically. An item is `"completed"` when the
 * primitive's own result carries no `error`; a primitive that returns
 * `result.error` (rather than throwing) is treated as a failed attempt
 * and re-run under the same policy.
 *
 * Cancellation short-circuits: if the signal is already aborted on
 * entry the item is reported `"cancelled"` without executing; an abort
 * observed mid-flight surfaces as `"cancelled"` too.
 */
export async function runBatchItem<TInput, TOptions, TResult extends BaseResult>(
  params: RunBatchItemParams<TInput, TOptions, TResult>,
): Promise<BatchItemResult<TResult>> {
  const { index, input, executable, signal } = params;

  if (signal?.aborted) {
    return { index, status: "cancelled", attempts: 0 };
  }

  const retryConfig = resolveRetryConfig({ retry: params.retry }, undefined);
  const totalAttempts = Math.max(1, retryConfig.attempts ?? 1);

  let lastResult: TResult | undefined;
  let lastError: unknown;
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    if (signal?.aborted) {
      return { index, status: "cancelled", result: lastResult, attempts: attemptsMade };
    }

    attemptsMade = attempt;

    try {
      const result = await executable.execute(input, { signal } as TOptions);
      lastResult = result;

      if (!result.error) {
        return { index, status: "completed", result, attempts: attempt };
      }

      lastError = result.error;
    } catch (error) {
      if (isAbortError(error)) {
        return { index, status: "cancelled", result: lastResult, attempts: attempt };
      }

      lastError = error;
    }

    const canRetry =
      attempt < totalAttempts &&
      (retryConfig.retryOn ? retryConfig.retryOn(lastError, attempt) !== false : true);

    if (!canRetry) {
      break;
    }

    retryConfig.onRetry?.(attempt + 1, lastError);

    const delay = resolveBackoff(attempt, retryConfig.backoff);
    if (delay > 0) {
      await sleep(delay, signal);
    }
  }

  if (signal?.aborted) {
    return { index, status: "cancelled", result: lastResult, attempts: attemptsMade };
  }

  return {
    index,
    status: "failed",
    result: lastResult,
    error: toAIError(lastError),
    attempts: attemptsMade,
  };
}
