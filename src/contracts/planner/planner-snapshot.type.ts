import type { BaseReport } from "../result/base-report.type";
import type { Usage } from "../result/usage.type";
import type { PlannerPlan } from "./planner-plan.type";
import type { PlannerStepSnapshot } from "./planner-result.type";

/**
 * Lifecycle status of a durable planner run, recorded on the persisted
 * snapshot so `resume()` can decide whether a run is still in flight.
 *
 * - `"running"` — the execution loop is active; a resume is legitimate
 *   if the process crashed between node boundaries.
 * - `"completed"` — the planner terminated successfully; resume is a
 *   no-op and re-returns the final result rebuilt from the snapshot.
 * - `"cancelled"` — aborted via `AbortSignal`; resume is allowed.
 * - `"failed"` — terminated with an error; resume after the fix.
 */
export type PlannerSnapshotStatus =
  | "running"
  | "completed"
  | "cancelled"
  | "failed";

/**
 * Persisted shape written to the configured {@link
 * import("../orchestrator/snapshot-store.contract").SnapshotStore} after
 * every plan node settles. Exists so `planner.resume(runId)` can
 * re-hydrate the frozen plan + per-node ledger + rolled-up usage +
 * child reports and continue scheduling the unfinished DAG / sequential
 * tail.
 *
 * **Checkpoint granularity is per-node.** The snapshot is written at the
 * end of `executeStep`, after the step's `PlannerStepSnapshot` is pushed
 * and its usage + child report folded in. A completed node's capability
 * dispatch is never re-invoked on resume — the sequential skip-guard /
 * DAG re-seed derive the completed-node set from `executedSteps`.
 *
 * `signature` is the same structural fingerprint exposed on the planner
 * instance (`computeSignature(name, capabilities)`). `resume()` compares
 * it against the current definition; a mismatch throws `PlannerDriftError`
 * (bypassable with `{ force: true }`). A mid-run re-plan is NOT drift —
 * the plan changed, not the definition; `replanCount` is persisted so the
 * replan budget is honored across a resume.
 *
 * Every field is JSON-serializable — `PlannerPlan`, `PlannerStepSnapshot`,
 * `Usage`, and `BaseReport` are the same plain-data shapes already
 * persisted on reports.
 *
 * @example
 * const snapshot: PlannerSnapshot | undefined = await store.load(runId);
 * if (snapshot?.status === "running") {
 *   await planner.resume(runId);
 * }
 */
export type PlannerSnapshot = {
  /** The store key — stable across the whole run. */
  runId: string;
  /** Planner name, for the resume error message + attribution. */
  plannerName: string;
  /** Structural drift fingerprint — `computeSignature(name, capabilities)`. */
  signature: string;
  /** `PlannerConfig.version` — metadata only, never compared. */
  version?: string;
  /** The original `execute(goal)` value — needed to rebuild prompts on replan. */
  goal: string;
  /**
   * The frozen plan generated on the first run. Resume must NOT re-call
   * the planning LLM — re-asking would burn tokens and risk a different
   * plan that no longer matches the executed-node ledger.
   */
  plan: PlannerPlan;
  /**
   * Per-node ledger (completed / failed / skipped). This IS the
   * completed-node set — the sequential skip-guard and DAG re-seed both
   * reconstruct "what ran" from it.
   */
  executedSteps: PlannerStepSnapshot[];
  /** Rolled-up usage across executed nodes — never double-counted on resume. */
  usage: Usage;
  /** Child reports accumulated across executed nodes. */
  children: BaseReport[];
  /** Replan budget consumed so far, so a resume can't exceed `maxReplans`. */
  replanCount: number;
  status: PlannerSnapshotStatus;
  startedAt: string;
  savedAt: string;
};
