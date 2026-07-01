import type { AIErrorOptions } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";
import { PlannerFailedError } from "./planner-failed-error";

export type PlannerDriftErrorOptions = AIErrorOptions & {
  /** Signature recorded on the snapshot being resumed. */
  savedSignature: string;
  /** Signature computed from the current planner definition. */
  currentSignature: string;
  runId: string;
};

/**
 * `planner.resume(runId)` loaded a durable snapshot whose structural
 * fingerprint does not match the current planner definition (name +
 * ordered capability names). The resume is refused — no node runs — and
 * the user decides how to recover: discard the snapshot, migrate
 * manually, or call `resume(runId, { force: true })` to bypass the check.
 *
 * A mid-run re-plan is NOT drift — the plan changed, not the definition;
 * the persisted `replanCount` honors the replan budget across a resume.
 *
 * Mirrors `SupervisorDriftError` / `WorkflowDriftError` — same rationale,
 * different primitive. Thrown (not returned on `result.error`) because a
 * drifted resume never produces a valid run.
 */
export class PlannerDriftError extends PlannerFailedError {
  public static readonly defaultCategory: ErrorCategory = "drift";

  public readonly savedSignature: string;
  public readonly currentSignature: string;
  public readonly runId: string;

  public constructor(message: string, options: PlannerDriftErrorOptions) {
    super(message, options, "PLANNER_DRIFT");
    this.name = "PlannerDriftError";
    this.savedSignature = options.savedSignature;
    this.currentSignature = options.currentSignature;
    this.runId = options.runId;
  }
}
