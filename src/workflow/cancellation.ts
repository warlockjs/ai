import { WorkflowCancelledError } from "../errors";

/**
 * Build a `WorkflowCancelledError` from an `AbortSignal`, extracting
 * a human-readable reason from `signal.reason` (string | Error | any).
 * Used both at between-step boundaries and inside the retry backoff
 * sleep.
 */
export function createCancelledError(
  signal: AbortSignal | undefined,
): WorkflowCancelledError {
  const reason = signal?.reason;
  const reasonText =
    typeof reason === "string"
      ? reason
      : reason instanceof Error
        ? reason.message
        : reason === undefined
          ? ""
          : String(reason);

  return new WorkflowCancelledError(
    `workflow cancelled${reasonText ? `: ${reasonText}` : ""}`,
    { cancelledAt: new Date().toISOString(), reason: reasonText },
  );
}

/**
 * Promise-based sleep that resolves after `ms` milliseconds, or
 * rejects with `WorkflowCancelledError` if the signal fires. The
 * timer is cleared on abort so we never leak a pending setTimeout.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createCancelledError(signal));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(createCancelledError(signal));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
