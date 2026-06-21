import { AIError, type AIErrorOptions } from "./ai-error";
import type { AIErrorCode } from "./error-code.type";

/**
 * Base class for every orchestrator-specific failure surfaced from
 * `orchestrator.execute()` / `orchestrator.resume()` /
 * `orchestrator.command()` or thrown at authoring-time by
 * `ai.orchestrator()` validation (orchestrator.md §17).
 *
 * **Role.** Anchor for the `ORCHESTRATOR_*` code family. Subclasses
 * carry precise codes (`ORCHESTRATOR_DRIFT`, `ORCHESTRATOR_CONFIG`,
 * `ORCHESTRATOR_CANCELLED`, …); this base catches everything a turn can
 * produce that isn't already an agent / tool / provider / supervisor
 * error bubbling up from the dispatched child.
 *
 * Child-execution errors (agent, tool, provider, supervisor) flow
 * through the orchestrator unchanged — they are captured on the turn's
 * `childReport` and surfaced on `result.error` directly, never
 * re-wrapped.
 *
 * @example
 * const result = await orchestrator.execute(message, { sessionId, history });
 * if (result.error instanceof OrchestratorFailedError) {
 *   console.error(result.error.code, result.error.message);
 * }
 */
export class OrchestratorFailedError extends AIError {
  public constructor(
    message: string,
    options?: AIErrorOptions,
    code: AIErrorCode = "ORCHESTRATOR_FAILED",
  ) {
    super(code, message, options);
    this.name = "OrchestratorFailedError";
  }
}
