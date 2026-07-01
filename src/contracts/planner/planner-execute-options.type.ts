import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Placeholders } from "../placeholders.type";
import type { PlannerPlan } from "./planner-plan.type";
import type { PlannerStepSnapshot } from "./planner-result.type";

/**
 * Steering verdict returned by the {@link PlannerExecuteOptions.onStep}
 * hook after a step settles.
 *
 * - `{ type: "continue" }` (or returning nothing) — proceed as normal.
 * - `{ type: "abort" }` — stop the run; remaining steps are recorded
 *   `skipped`, exactly as a step failure aborts today.
 * - `{ type: "replan"; feedback }` — re-ask the planning agent for a
 *   fresh plan over the REMAINING work, seeded with the executed-step
 *   digest plus `feedback`. Bounded by `config.replan.maxReplans`; a
 *   `replan` directive with no `replan` config is treated as `continue`.
 */
export type PlannerStepDirective =
  | { type: "continue" }
  | { type: "abort" }
  | { type: "replan"; feedback: string };

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
  /**
   * Approval gate. `"plan-only"` generates (and validates) the plan and
   * returns WITHOUT executing — `report.status === "awaiting-approval"`
   * and `result.plan` carries the generated plan. Pass that plan back via
   * `approvedPlan` to execute it. Defaults to `"execute"`.
   *
   * **`mode: "plan-only"` with `approvedPlan` is contradictory** —
   * `approvedPlan` wins (the plan is executed).
   */
  mode?: "execute" | "plan-only";
  /**
   * Execute this exact plan, skipping plan generation entirely. Pairs
   * with a prior `mode: "plan-only"` call's `result.plan`. The plan is
   * still validated against the live capabilities, so a stale plan
   * naming a capability the planner no longer has surfaces a typed
   * `PlannerPlanInvalidError`.
   */
  approvedPlan?: PlannerPlan;
  /**
   * Per-step hook fired after each step settles (both the sequential and
   * the DAG path). Return a {@link PlannerStepDirective} to steer the
   * run: continue (default), abort, or replan the remainder with
   * feedback. May be async.
   */
  onStep?: (
    snapshot: PlannerStepSnapshot,
    plan: PlannerPlan,
  ) => void | PlannerStepDirective | Promise<void | PlannerStepDirective>;
};

/**
 * Options accepted by `planner.resume(runId, options?)`.
 *
 * `force: true` bypasses the signature drift check — use only when you
 * have verified the definition change is safe for the in-flight
 * snapshot. `PlannerDriftError` is otherwise thrown without executing
 * anything. Everything else mirrors {@link PlannerExecuteOptions} (e.g.
 * re-supply a `signal` to keep the resumed run cancellable).
 */
export type PlannerResumeOptions<TOutput = unknown> = PlannerExecuteOptions<TOutput> & {
  /** Bypass the drift check and resume against the changed definition. */
  force?: boolean;
};
