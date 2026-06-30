import type { ClassifierSnapshot } from "../supervisor/classifier-context.type";
import type { AckSnapshot, IterationSnapshot } from "../supervisor/iteration-snapshot.type";
import type { BaseReport } from "./base-report.type";
import type { BaseResult } from "./base-result.type";

/**
 * How the supervisor decided to stop iterating. Recorded so log and
 * dashboard queries can slice "ended because router said END" from
 * "ran out of iterations" from "user aborted" without re-reading the
 * error object.
 */
export type SupervisorTerminatedBy =
  | "router"
  | "route"
  | "classifier"
  | "evaluate"
  | "max-iterations"
  | "cancelled"
  | "error";

/**
 * Supervisor-specific execution report. Extends {@link BaseReport}
 * with supervisor-only fields — iteration count, termination reason,
 * per-iteration snapshots — while sharing the canonical timing,
 * status, usage, and recursive `children[]` block with every other
 * primitive.
 *
 * `snapshots` remains the primary iteration-granularity debug artifact
 * — every routing decision, every dispatch, every evaluate verdict.
 * The cross-cutting view of "which executables ran underneath" lives
 * on {@link BaseReport.children}, which duplicates nothing: it's the
 * reports of the child agents/workflows dispatched across iterations.
 */
export type SupervisorReport = BaseReport & {
  /**
   * Discriminator for the supervisor engine. `"team"` when produced by
   * `ai.team` (thin sugar over the same engine) so team runs are
   * distinguishable on the wire — group/filter as their own type — while
   * sharing this report shape; `"supervisor"` for a plain `ai.supervisor`.
   */
  type: "supervisor" | "team";
  supervisorName: string;
  /** Structural fingerprint — same value exposed on the instance. */
  signature: string;
  terminatedBy: SupervisorTerminatedBy;
  /** How many iterations ran (including the terminal one). */
  iterations: number;
  /** ISO-8601 timestamp when a cancellation was observed, if any. */
  cancelledAt?: string;
  snapshots: IterationSnapshot[];
  /**
   * Receptionist (`ackAgent`) forensic record. Present only when an
   * ack agent was configured AND the run started fresh (resumes don't
   * re-fire ack). The ack agent's full report node also lives under
   * `children[]` like any other dispatched agent.
   */
  ack?: AckSnapshot;
  /**
   * Classifier (Phase 7 / decisions §37) forensic record. Present
   * only when `SupervisorConfig.classifier` was configured AND the
   * run started fresh (resumes don't re-fire classifier). Sibling of
   * `ack` — full forensic detail regardless of what strip-merged
   * into state. Distinct from the children list — classifier runs
   * are not also pushed onto `children[]`.
   */
  classifier?: ClassifierSnapshot;
};

/**
 * Result returned by `supervisor.execute()` and resolved by
 * `stream.result`. Canonical destructure —
 * `const { data, report, usage, error } = await supervisor.execute(...)` —
 * mirrors agent and workflow so nested composition feels uniform.
 *
 * `data` populates only on successful completion of a supervisor
 * configured with `output`. On failure or cancellation it is
 * `undefined`; `error` carries the typed cause and `report.status`
 * narrows further.
 *
 * `usage` is rolled up from every child executable this supervisor
 * ran (router agent, dispatched agents/workflows, evaluate agent) —
 * see {@link BaseReport} rollup semantics.
 *
 * @example
 * const { data, report, usage, error } = await supervisor.execute(input);
 *
 * if (error) {
 *   logger.error(error.code, {
 *     terminatedBy: report.terminatedBy,
 *     iterations: report.iterations,
 *   });
 *   return;
 * }
 *
 * return { answer: data, cost: usage.total, turns: report.iterations };
 */
export type SupervisorResult<TOutput = unknown> = BaseResult & {
  /**
   * Discriminant for narrowing `SessionSendResult.executionResult`.
   * `"team"` for `ai.team` runs (sugar over the same engine), else
   * `"supervisor"` — matches the report's discriminator.
   */
  type: "supervisor" | "team";
  data?: TOutput;
  report: SupervisorReport;
};
