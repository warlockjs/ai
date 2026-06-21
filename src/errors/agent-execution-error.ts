import { AIError, type AIErrorOptions } from "./ai-error";
import type { AIErrorCode } from "./error-code.type";

/**
 * Base for agent runtime failures that aren't schema / tool / provider
 * problems — runtime-structural issues inside the trip loop or
 * authoring-time middleware misconfiguration. Two specialized
 * subclasses cover the two non-generic cases:
 *
 * - {@link AgentCancelledError} (`AGENT_CANCELLED`) — caller-driven
 *   abort via `AbortSignal`.
 * - {@link AgentMaxTripsError} (`AGENT_MAX_TRIPS`) — trip loop hit
 *   the `maxTrips` cap without a natural stop.
 *
 * Use the base class directly for anything else (unregistered tool
 * dispatch, authoring-time middleware validation, surprise
 * exceptions). The subclasses exist so consumers can branch on a
 * dedicated `instanceof` / category without inferring from `context`
 * flags or parsing the message.
 *
 * @example
 * if (result.error?.code === "AGENT_EXEC_FAILED") {
 *   logger.warn("unexpected agent failure", result.error.context);
 * }
 */
export class AgentExecutionError extends AIError {
  public constructor(
    message: string,
    options?: AIErrorOptions,
    code: AIErrorCode = "AGENT_EXEC_FAILED",
  ) {
    super(code, message, options);
    this.name = "AgentExecutionError";
  }
}
