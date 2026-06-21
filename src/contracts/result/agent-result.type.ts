import type { BaseResult } from "./base-result.type";
import type { AgentReport } from "./execution-report.type";

/**
 * Result returned by `agent.execute()` and resolved by `stream.result`.
 *
 * **Canonical destructuring:** `const { data, text, report, usage, error }`.
 *
 * `report.trips` / `report.toolCalls` / `report.duration` hold
 * everything the old top-level fields did — moving them under
 * `report` leaves the root clean for the four things callers reach
 * for constantly (`data`, `text`, `usage`, `error`).
 *
 * @example
 * const { data, error, report, usage } = await agent.execute(input);
 *
 * if (error) {
 *   logger.error(error.code, { duration: report.duration });
 *   return;
 * }
 *
 * return { answer: data, cost: usage.total, latency: report.duration };
 */
export type AgentResult<TOutput = unknown> = BaseResult & {
  /** Discriminant for narrowing `SessionSendResult.executionResult`. */
  type: "agent";
  /** Typed structured output when the caller passed an `output` schema. */
  data?: TOutput;
  /** Raw text from the final LLM trip. */
  text?: string;
  /** Trips, tool calls, status, and timing for this execution. */
  report: AgentReport;
};
