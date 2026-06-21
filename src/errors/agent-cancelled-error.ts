import { AgentExecutionError } from "./agent-execution-error";
import type { AIErrorOptions } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";

/**
 * Payload for {@link AgentCancelledError}. `cancelledAt` is the
 * ISO-8601 timestamp at which the abort was observed; `reason`
 * carries the value the caller supplied to `controller.abort(reason)`
 * when present.
 */
export type AgentCancelledErrorOptions = AIErrorOptions & {
  cancelledAt?: string;
  reason?: string;
};

/**
 * Agent run was cancelled via `AbortSignal` before it could finish.
 * Between-trip cancellation is guaranteed; mid-trip cancellation is
 * best-effort (the signal is threaded into the provider adapter's
 * HTTP client when supported).
 *
 * Surfaced on `result.error` rather than thrown — `agent.execute()`
 * still returns with `report.status = "cancelled"` and partial trip
 * history intact. Consumers branch on the class (not the message) to
 * distinguish caller-initiated stops from other failures.
 *
 * **Why split from `AgentExecutionError`.** Cancellation is a
 * different operational signal from "the agent crashed" — retry
 * policy and dashboards typically want different behavior for each.
 * Keeping cancellation in its own class lets the category
 * (`"cancelled"`) be set declaratively per type instead of inferred
 * from a `context.cancelled === true` flag.
 *
 * @example
 * const result = await agent.execute(input, { signal });
 * if (result.error instanceof AgentCancelledError) {
 *   // caller pulled the plug — don't retry, surface a "stopped" UI
 *   return { status: "cancelled" };
 * }
 */
export class AgentCancelledError extends AgentExecutionError {
  public static readonly defaultCategory: ErrorCategory = "cancelled";

  public readonly cancelledAt?: string;
  public readonly reason?: string;

  public constructor(message: string, options?: AgentCancelledErrorOptions) {
    super(message, options, "AGENT_CANCELLED");
    this.name = "AgentCancelledError";
    this.cancelledAt = options?.cancelledAt;
    this.reason = options?.reason;
  }
}
