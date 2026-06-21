/**
 * Coarse error grouping for dashboards and routing logic. `code` is too
 * granular for "what's failing this week" charts — the category union
 * is the dispatch key that drives:
 *
 * - Panoptic / dashboard aggregations (pie chart of failures by
 *   category)
 * - Retry policy (`rate-limit` → retry with backoff; `auth` → don't
 *   retry, escalate)
 * - User-facing error mapping (`content-filter` → soft message;
 *   `provider` → "we're having issues, try again")
 *
 * Each `AIError` subclass declares its category via a `static
 * defaultCategory` field, so the value is inherent to the error type
 * rather than constructor-supplied — bugs that forget to set a
 * category are caught at class-definition time, not at runtime. Direct
 * `new AIError(...)` usages may pass `category` in options as an
 * escape hatch.
 *
 * @example
 * if (error.category === "rate-limit") {
 *   await sleep(error.context?.retryAfterMs ?? 1000);
 *   return retry();
 * }
 */
export type ErrorCategory =
  | "auth"
  | "rate-limit"
  | "timeout"
  | "validation"
  | "content-filter"
  | "provider"
  | "tool"
  | "cancelled"
  | "max-trips"
  | "max-iterations"
  | "max-steps"
  | "schema"
  | "drift"
  | "routing"
  | "guardrail"
  | "budget"
  | "quota"
  | "context-length"
  | "unknown";
