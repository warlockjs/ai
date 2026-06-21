import { AIError, type AIErrorOptions } from "./ai-error";
import type { AIErrorCode } from "./error-code.type";

/**
 * Base class for every supervisor-specific failure surfaced from
 * `supervisor.execute()` / `supervisor.resume()` / authoring-time
 * `ai.supervisor()` validation.
 *
 * **Role.** Anchor for the `SUPERVISOR_*` code family. Subclasses
 * carry precise codes (`SUPERVISOR_MAX_ITERATIONS`,
 * `SUPERVISOR_INVALID_ROUTE`, …); this base catches everything a
 * supervisor run can produce that isn't already an agent / tool /
 * provider / workflow error bubbling up from a child execution.
 *
 * Child-execution errors (agent, tool, provider, workflow) flow
 * through the supervisor unchanged — they are captured on the
 * relevant branch snapshot and, if fatal, wrapped as the `cause` of a
 * `SupervisorFailedError` only when the supervisor itself has no
 * narrower subclass to throw.
 *
 * @example
 * try {
 *   ai.supervisor({
 *     route: () => "triage",
 *     router: routerAgent,
 *     intents: { triage },
 *   });
 * } catch (error) {
 *   if (error instanceof SupervisorFailedError) {
 *     console.error(error.code, error.message);
 *   }
 * }
 */
export class SupervisorFailedError extends AIError {
  public constructor(
    message: string,
    options?: AIErrorOptions,
    code: AIErrorCode = "SUPERVISOR_FAILED",
  ) {
    super(code, message, options);
    this.name = "SupervisorFailedError";
  }
}
