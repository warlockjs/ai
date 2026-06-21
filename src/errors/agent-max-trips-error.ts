import { AgentExecutionError } from "./agent-execution-error";
import type { AIErrorOptions } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";

/**
 * Payload for {@link AgentMaxTripsError}. `maxTrips` is the cap the
 * agent hit — useful for log/metric attribution and for retry-with-
 * higher-cap recovery strategies.
 */
export type AgentMaxTripsErrorOptions = AIErrorOptions & {
  maxTrips: number;
};

/**
 * Runaway-loop hard guard: the agent's trip loop ran `maxTrips` round
 * trips to the model without the model issuing a natural stop. The
 * loop terminates with this typed error on `result.error` and the
 * full trip history preserved in `result.report.trips` so consumers
 * can see where the loop got stuck.
 *
 * **Not retryable by default.** A run that hit the cap usually
 * indicates either a tool the agent can't satisfy (causing infinite
 * re-asks) or a model that won't commit to an answer. Bumping
 * `maxTrips` and retrying without root-causing the underlying issue
 * just burns more tokens.
 *
 * **Why split from `AgentExecutionError`.** The catch-all base wears
 * too many hats — cancellation vs. max-trips vs. generic crashes had
 * to be disambiguated from `context` flags or message regex. Split
 * subclasses let category dispatch (`"max-trips"`) and consumer
 * branching (`instanceof`) work without inference.
 *
 * @example
 * if (result.error instanceof AgentMaxTripsError) {
 *   logger.warn("agent hit trip cap", { max: result.error.maxTrips });
 * }
 */
export class AgentMaxTripsError extends AgentExecutionError {
  public static readonly defaultCategory: ErrorCategory = "max-trips";

  public readonly maxTrips: number;

  public constructor(message: string, options: AgentMaxTripsErrorOptions) {
    super(message, options, "AGENT_MAX_TRIPS");
    this.name = "AgentMaxTripsError";
    this.maxTrips = options.maxTrips;
  }
}
