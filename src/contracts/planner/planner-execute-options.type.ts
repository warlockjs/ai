import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Placeholders } from "../placeholders.type";

/**
 * Options accepted by `planner.execute(goal, options?)`.
 *
 * Every field is optional — `planner.execute(goal)` runs end-to-end
 * with the planner's configured defaults.
 */
export type PlannerExecuteOptions<TOutput = unknown> = {
  /** Stable run-id for this execution. Generated when absent. */
  runId?: string;
  /**
   * Placeholder values injected into the plan-generation prompt's
   * `{{mustache}}` slots (`model` mode only).
   */
  placeholders?: Placeholders;
  /**
   * Per-call override of the configured `output` schema. When set, the
   * planner validates the final step output against this instead of
   * the factory-level `output`.
   */
  output?: StandardSchemaV1<TOutput>;
  /**
   * Cancellation handle. When `signal.aborted` becomes true the planner
   * short-circuits at the next step boundary and returns with
   * `report.status === "cancelled"` and `result.error` set to a
   * `PlannerCancelledError`. The signal is also threaded into every
   * in-flight capability dispatch — mid-step abort is best-effort and
   * depends on the child primitive honoring it.
   */
  signal?: AbortSignal;
  /**
   * Caller-supplied identifier that groups multiple `execute()` calls
   * into one conceptual session. Mirrored onto every report node this
   * run produces (and every nested executable it dispatches) so flat
   * trace queries don't need to walk the tree.
   */
  sessionId?: string;
};
