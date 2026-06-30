import type { ApprovalHandler, InterruptPolicy } from "./approval.type";
import type { InterruptStore } from "./interrupt-store.contract";

/**
 * Options for `ai.human.approval(options)` — the `tool.before`
 * approval-gate middleware factory.
 *
 * The middleware evaluates {@link HumanApprovalOptions.policy} against
 * each pending tool call; for gated calls it builds an
 * {@link import("./approval.type").ApprovalRequest} and routes it to
 * {@link HumanApprovalOptions.handler}, then applies the returned
 * {@link import("./approval.type").ApprovalDecision} (approve → continue;
 * reject → short-circuit a typed error; edit → run with replaced args).
 */
export interface HumanApprovalOptions {
  /**
   * Stable middleware name. Middleware names are validated unique per
   * agent, so two approval middlewares on one agent need distinct names.
   * Defaults to `"human-approval"`.
   */
  name?: string;

  /** Which tool calls require a human. */
  policy: InterruptPolicy;

  /** How a gated call reaches a human and yields a decision. */
  handler: ApprovalHandler;

  /**
   * Optional durable store. When set **and** the handler throws
   * {@link import("../errors").InterruptSuspendedError}, the pending
   * request is persisted here for out-of-process resume via
   * `ai.human.resume(interruptId, decision)`. Omit for pure interactive
   * (await-in-process) mode.
   */
  store?: InterruptStore;
}
