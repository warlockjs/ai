import type { AIError } from "../../errors/ai-error";
import type { BaseReport } from "../result/base-report.type";
import type { ExecuteResult } from "../result/execute-result.type";
import type { Usage } from "../result/usage.type";
import type { PlannerPlan, PlannerStep } from "./planner-plan.type";

/**
 * Discriminator literal the planner stamps onto its report's `type`
 * field. A member of the shared
 * {@link import("../result/base-report.type").ReportType} closed union.
 *
 * {@link PlannerReport} re-declares `type` as this literal by *overriding*
 * it (`Omit<BaseReport, "type"> & { type: PlannerReportType }`) rather than
 * intersecting (`BaseReport & { type: "planner" }`). Intersecting a single
 * literal against `BaseReport.type` (the whole `ReportType` union) lets a
 * strict TypeScript collapse the entire report to `never` ("property `type`
 * has conflicting types in some constituents"); the `Omit` override sidesteps
 * that while still producing the same `type: "planner"` for consumers.
 */
export type PlannerReportType = "planner";

/**
 * Forensic record of a single executed plan step on
 * {@link PlannerReport.executedSteps}.
 *
 * Mirrors the supervisor/orchestrator snapshot shape so a step reads
 * uniformly. Frozen-friendly plain data — the dispatched capability's
 * full report tree lives on `childReport` AND under
 * {@link BaseReport.children}, matching the universal rollup invariant.
 */
export type PlannerStepSnapshot = {
  /** 0-based position of this step in the executed plan. */
  index: number;
  /** The plan step that drove this dispatch. */
  step: PlannerStep;
  /** Terminal status of this step's capability dispatch. */
  status: "completed" | "failed" | "skipped";
  /** The capability's typed output when it completed, if any. */
  output?: unknown;
  /** Typed failure cause when the step failed; undefined on success. */
  error?: AIError;
  startedAt: string;
  endedAt: string;
  duration: number;
  usage: Usage;
  /** The dispatched capability's full report tree. */
  childReport?: BaseReport;
};

/**
 * Planner-specific execution report — {@link BaseReport} plus the
 * generated plan, the per-step execution snapshots, and the planner's
 * structural signature.
 *
 * `children[]` carries every capability dispatched during plan
 * execution, in execution order — the cross-cutting tree view shared
 * with every other primitive. `executedSteps` is the authoritative
 * per-step record (one entry per step the planner attempted), and
 * `plan` is the verbatim LLM output before any step ran.
 */
export type PlannerReport = Omit<BaseReport, "type"> & {
  type: PlannerReportType;
  /** Structural fingerprint — same value exposed on the planner instance. */
  signature: string;
  /** The full plan the planner's LLM generated before execution began. */
  plan?: PlannerPlan;
  /** Per-step forensic records, in execution order. */
  executedSteps: PlannerStepSnapshot[];
  /** ISO-8601 timestamp when cancellation was observed, if any. */
  cancelledAt?: string;
};

/**
 * Result returned by `planner.execute()`. Satisfies the unified
 * {@link ExecuteResult} envelope — `usage` and `report` are the
 * rolled-up totals across the plan-generation trip plus every executed
 * step — and adds the planner discriminant.
 *
 * `data` holds the final step's typed output (or the planner's
 * structured `output` when an `output` schema was configured). On
 * failure or cancellation it is `undefined`; `error` carries the typed
 * cause and `report.status` narrows further.
 *
 * @example
 * const { data, report, usage, error } = await planner.execute(goal);
 *
 * if (error) {
 *   logger.error(error.code, { steps: report.executedSteps.length });
 *   return;
 * }
 *
 * console.log(report.plan?.summary, usage.total);
 */
export type PlannerResult<TOutput = unknown> = Omit<ExecuteResult<TOutput>, "report"> & {
  /** Discriminant for narrowing a heterogeneous result union. */
  type: "planner";
  report: PlannerReport;
  /**
   * The generated plan, surfaced WITHOUT execution when the run was
   * invoked with `mode: "plan-only"` (`report.status ===
   * "awaiting-approval"`). Pass it back as `approvedPlan` on a follow-up
   * `execute()` to run it. Absent on a normal execute run — the executed
   * plan lives on `report.plan`.
   */
  plan?: PlannerPlan;
};
