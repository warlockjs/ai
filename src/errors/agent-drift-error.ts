import type { AIErrorOptions } from "./ai-error";
import { AgentExecutionError } from "./agent-execution-error";
import type { ErrorCategory } from "./error-category.type";

export type AgentDriftErrorOptions = AIErrorOptions & {
  /** Signature recorded on the snapshot being resumed. */
  savedSignature: string;
  /** Signature computed from the current agent definition. */
  currentSignature: string;
  runId: string;
};

/**
 * `agent.resume(runId)` loaded a durable snapshot whose structural
 * fingerprint does not match the current agent definition (model +
 * provider + sorted tool names + maxTrips + output presence + version).
 * The resume is refused — no trip runs — and the user decides how to
 * recover: discard the snapshot, migrate manually, or call
 * `resume(runId, { force: true })` to bypass the check.
 *
 * Mirrors `SupervisorDriftError` / `WorkflowDriftError` — same rationale,
 * different primitive. Thrown (not returned on `result.error`) because a
 * drifted resume never produces a valid run.
 */
export class AgentDriftError extends AgentExecutionError {
  public static readonly defaultCategory: ErrorCategory = "drift";

  public readonly savedSignature: string;
  public readonly currentSignature: string;
  public readonly runId: string;

  public constructor(message: string, options: AgentDriftErrorOptions) {
    super(message, options, "AGENT_DRIFT");
    this.name = "AgentDriftError";
    this.savedSignature = options.savedSignature;
    this.currentSignature = options.currentSignature;
    this.runId = options.runId;
  }
}
