import type { AIErrorOptions } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";
import { SupervisorFailedError } from "./supervisor-failed-error";

export type SupervisorDriftErrorOptions = AIErrorOptions & {
  /** Signature recorded on the snapshot being resumed. */
  savedSignature: string;
  /** Signature computed from the current supervisor definition. */
  currentSignature: string;
  runId: string;
};

/**
 * `supervisor.resume(runId)` loaded a snapshot whose structural
 * fingerprint does not match the current supervisor definition
 * (agent keys + descriptions + router identity + route presence).
 * The resume is refused — no iteration runs — and the user decides
 * how to recover: discard the snapshot, migrate manually, or call
 * `resume(runId, { force: true })` to bypass the check.
 *
 * Mirrors `WorkflowDriftError` for workflow resume — same rationale,
 * different primitive.
 */
export class SupervisorDriftError extends SupervisorFailedError {
  public static readonly defaultCategory: ErrorCategory = "drift";

  public readonly savedSignature: string;
  public readonly currentSignature: string;
  public readonly runId: string;

  public constructor(message: string, options: SupervisorDriftErrorOptions) {
    super(message, options, "SUPERVISOR_DRIFT");
    this.name = "SupervisorDriftError";
    this.savedSignature = options.savedSignature;
    this.currentSignature = options.currentSignature;
    this.runId = options.runId;
  }
}
