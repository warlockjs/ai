import type { AIErrorOptions } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";
import { SupervisorFailedError } from "./supervisor-failed-error";

export type SupervisorRoutingErrorOptions = AIErrorOptions & {
  /**
   * The raw value the `route` callback or router agent returned. Keyed
   * `unknown` because a misbehaving router can emit any JSON value —
   * consumers should format it for display, not trust its shape.
   */
  returned: unknown;
  /** Every legal intent key configured on the supervisor at run time. */
  availableKeys: string[];
};

/**
 * A `route` callback or router agent returned a value that doesn't
 * resolve to a configured agent key, a `string[]` of configured keys,
 * or the `END` sentinel. Routing is authoritative — there is no
 * recovery path, so the supervisor terminates the run immediately.
 *
 * Named `SupervisorRoutingError` (not `RoutingError`) to avoid
 * colliding with `@warlock.js/ai`'s existing workflow `RoutingError`
 * (`WORKFLOW_INVALID_GOTO`). Both carry the same semantic weight —
 * "routing asked for something I can't dispatch" — in their
 * respective primitives.
 *
 * @example
 * const { error } = await supervisor.execute(input);
 * if (error?.code === "SUPERVISOR_INVALID_ROUTE") {
 *   logger.error("bad router decision", {
 *     returned: (error as SupervisorRoutingError).returned,
 *     available: (error as SupervisorRoutingError).availableKeys,
 *   });
 * }
 */
export class SupervisorRoutingError extends SupervisorFailedError {
  public static readonly defaultCategory: ErrorCategory = "routing";

  public readonly returned: unknown;
  public readonly availableKeys: string[];

  public constructor(message: string, options: SupervisorRoutingErrorOptions) {
    super(message, options, "SUPERVISOR_INVALID_ROUTE");
    this.name = "SupervisorRoutingError";
    this.returned = options.returned;
    this.availableKeys = options.availableKeys;
  }
}
