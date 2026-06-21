import type { AIErrorOptions } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";
import { OrchestratorFailedError } from "./orchestrator-failed-error";

/**
 * Authoring-time misconfiguration of `ai.orchestrator(config)`
 * (orchestrator.md §17). Thrown synchronously at construction — never
 * surfaced via `result.error` — so a bad definition fails fast at boot
 * rather than on the first turn.
 *
 * Examples (§17): `iterate: true` with no `snapshotStore` (or
 * `ai.config({ defaultSnapshotStore })`); no resolvable
 * `checkpointStore`; both `route` and `router` configured;
 * `initialAgent` that is not a key in `intents`.
 *
 * Mirrors the `authoring: true` context tag the supervisor factory
 * stamps on its construction-time failures.
 */
export class OrchestratorConfigError extends OrchestratorFailedError {
  public static readonly defaultCategory: ErrorCategory = "validation";

  public constructor(message: string, options?: AIErrorOptions) {
    super(message, options, "ORCHESTRATOR_CONFIG");
    this.name = "OrchestratorConfigError";
  }
}
