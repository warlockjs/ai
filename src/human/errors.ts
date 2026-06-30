import { AIError, type AIErrorOptions } from "../errors/ai-error";
import type { AIErrorCode } from "../errors/error-code.type";

/**
 * Stable, machine-readable codes this package raises.
 *
 * `@warlock.js/ai`'s `AIErrorCode` is a closed union that (by design)
 * does not enumerate satellite-package codes, and this package must not
 * modify the core union. These codes are therefore declared locally and
 * narrowed into the base `AIError` `code` slot at the single `super(...)`
 * call — the runtime string is exactly what a consumer branches on via
 * `error.code`, identical to every other `AIError`.
 */
export type HumanErrorCode = "INTERRUPT_SUSPENDED" | "APPROVAL_REJECTED";

/**
 * Payload for {@link InterruptSuspendedError}. `interruptId` is the key a
 * later `ai.human.resume(interruptId, decision)` call uses to replay the
 * decision against the persisted interrupt.
 */
export type InterruptSuspendedErrorOptions = AIErrorOptions & {
  /** Id of the persisted interrupt awaiting a decision. */
  interruptId: string;
};

/**
 * A durable approval handler suspended the run rather than denying the
 * call.
 *
 * **Role.** The sentinel a durable {@link import("./contracts").ApprovalHandler}
 * throws after persisting a
 * {@link import("./contracts").PendingInterrupt}. The approval
 * middleware recognizes its own sentinel (an `instanceof` check) and
 * re-throws so the agent run unwinds; the dispatch records it as a failed
 * tool call carrying this typed error. The caller reads
 * `error.interruptId` off the surfaced `result.error`, surfaces it to the
 * reviewer, and later calls `ai.human.resume(...)`.
 *
 * Surfaced via `result.error` like every other `AIError` — the middleware
 * never lets it escape `execute()`.
 *
 * @example
 * if (result.error instanceof InterruptSuspendedError) {
 *   await notifyReviewer(result.error.interruptId);
 *   return { status: "awaiting-approval", interruptId: result.error.interruptId };
 * }
 */
export class InterruptSuspendedError extends AIError {
  /** Id of the persisted interrupt awaiting a human decision. */
  public readonly interruptId: string;

  public constructor(message: string, options: InterruptSuspendedErrorOptions) {
    super("INTERRUPT_SUSPENDED" as AIErrorCode, message, options);

    this.name = "InterruptSuspendedError";
    this.interruptId = options.interruptId;
  }
}

/**
 * Payload for {@link ApprovalRejectedError}. `reason` is the reviewer's
 * explanation, surfaced to the model on the next trip so it can
 * self-correct; `toolName` names the call that was rejected.
 */
export type ApprovalRejectedErrorOptions = AIErrorOptions & {
  /** The reviewer's explanation for rejecting the call. */
  reason: string;
  /** Name of the tool whose call was rejected. */
  toolName: string;
};

/**
 * A human rejected a gated tool call.
 *
 * **Role.** The typed result of an `{ type: "reject", reason }` decision.
 * The approval middleware throws it from `tool.before`; the agent
 * dispatch records a failed tool call and writes a `role: "tool"`
 * message carrying `reason`, so the **next trip lets the model
 * self-correct** — exactly the existing tool-error feedback path.
 *
 * Surfaced via `result.error` like every other `AIError`.
 *
 * @example
 * if (result.error instanceof ApprovalRejectedError) {
 *   logAudit(`${result.error.toolName} rejected: ${result.error.reason}`);
 * }
 */
export class ApprovalRejectedError extends AIError {
  /** The reviewer's explanation for rejecting the call. */
  public readonly reason: string;

  /** Name of the tool whose call was rejected. */
  public readonly toolName: string;

  public constructor(message: string, options: ApprovalRejectedErrorOptions) {
    super("APPROVAL_REJECTED" as AIErrorCode, message, options);

    this.name = "ApprovalRejectedError";
    this.reason = options.reason;
    this.toolName = options.toolName;
  }
}
