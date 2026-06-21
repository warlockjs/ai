import type { AIError } from "../../errors/ai-error";
import type { AgentResult } from "./agent-result.type";
import type { SupervisorResult } from "./supervisor-result.type";
import type { Usage } from "./usage.type";
import type { WorkflowResult } from "./workflow-result.type";

/**
 * Result returned by `SessionContract.send()`.
 * Narrows `executionResult` by checking the `type` discriminant.
 *
 * @deprecated Obsolete v2 forward-declaration. The locked v1
 * orchestrator's per-turn result is `OrchestratorResult<TOutput>` — see
 * `./orchestrator-result.type`. It extends the unified
 * {@link ExecuteResult} envelope (`data` / `error` / `usage` / `report`)
 * and adds `sessionId` / `turnIndex` / optional `compaction`, narrowing
 * via `report.type` / `report.status` rather than the `response` /
 * `done` / `executionResult` fields here. Retained unchanged for one
 * minor for non-breaking compatibility; do not use in new code.
 *
 * @example
 * const result = await session.send("Analyze this dataset");
 * if (result.executionResult.type === "agent") {
 *   console.log(result.executionResult.report.trips.length, "trips");
 * } else if (result.executionResult.type === "workflow") {
 *   console.log(Object.keys(result.executionResult.steps), "steps ran");
 * }
 */
export type SessionSendResult = {
  /** Final text response to display to the user */
  response: string;
  /** Whether the session is complete (no more turns expected) */
  done: boolean;
  /** Typed AI error if the session turn failed */
  error?: AIError;
  /** Full execution result — narrow by `.executionResult.type` */
  executionResult:
    | AgentResult<unknown>
    | SupervisorResult<unknown>
    | WorkflowResult<unknown>;
  /** Aggregated token usage for this turn */
  usage: Usage;
};
