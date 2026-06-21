import { SupervisorCancelledError } from "../errors";

/**
 * Build a `SupervisorCancelledError` from an `AbortSignal`. Extracts a
 * human-readable reason from `signal.reason` whether it was a string,
 * an `Error`, or some other value. Used at between-iteration boundaries
 * and on any mid-iteration cancellation path.
 */
export function createCancelledError(
  signal: AbortSignal | undefined,
): SupervisorCancelledError {
  const reason = signal?.reason;
  const reasonText =
    typeof reason === "string"
      ? reason
      : reason instanceof Error
        ? reason.message
        : reason === undefined
          ? ""
          : String(reason);

  return new SupervisorCancelledError(
    `supervisor cancelled${reasonText ? `: ${reasonText}` : ""}`,
    { cancelledAt: new Date().toISOString(), reason: reasonText },
  );
}
