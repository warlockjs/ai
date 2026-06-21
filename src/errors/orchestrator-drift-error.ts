import type { AIErrorOptions } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";
import { OrchestratorFailedError } from "./orchestrator-failed-error";

export type OrchestratorDriftErrorOptions = AIErrorOptions & {
  /** Signature recorded on the loaded checkpoint. */
  savedSignature: string;
  /** Signature computed from the current orchestrator definition. */
  currentSignature: string;
  /** The session whose checkpoint drifted. */
  sessionId: string;
};

/**
 * Phase 2 drift guard (orchestrator.md §3 / §10). `execute()` or
 * `resume()` loaded a checkpoint whose structural fingerprint does not
 * match the current orchestrator definition (name + intents map +
 * route/router presence + evaluate presence + initialAgent +
 * maxIterations + iterate flag + historyWindow shape — §10.1).
 *
 * The turn is refused synchronously — nothing dispatches — and the dev
 * decides how to recover: discard the session, migrate the persisted
 * state, or pass `{ force: true }` to accept the new signature on the
 * next persisted checkpoint.
 *
 * Mirrors `SupervisorDriftError` / `WorkflowDriftError` — same
 * rationale, orchestrator scope. The orchestrator signature does NOT
 * aggregate the internal supervisor's signature (§10.1); internal-
 * supervisor drift surfaces only on `iterate: true` resume via the
 * supervisor's own drift check.
 */
export class OrchestratorDriftError extends OrchestratorFailedError {
  public static readonly defaultCategory: ErrorCategory = "drift";

  public readonly savedSignature: string;
  public readonly currentSignature: string;
  public readonly sessionId: string;

  public constructor(message: string, options: OrchestratorDriftErrorOptions) {
    super(message, options, "ORCHESTRATOR_DRIFT");
    this.name = "OrchestratorDriftError";
    this.savedSignature = options.savedSignature;
    this.currentSignature = options.currentSignature;
    this.sessionId = options.sessionId;
  }
}
