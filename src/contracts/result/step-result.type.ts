import type { AIError } from "../../errors/ai-error";
import type { AgentResult } from "./agent-result.type";
import type { AttemptEntry } from "./attempt-entry.type";
import type { AgentReport } from "./execution-report.type";
import type { Usage } from "./usage.type";

export type { AttemptEntry };

/**
 * Frozen snapshot of a completed workflow step, stored under
 * `WorkflowReport.steps[name]` and `ctx.steps[name]`.
 *
 * For agent-backed steps, three forensic fields are surfaced at the
 * top level for easy inspection:
 *
 * - `agentReport` — trips, tool calls, status, timing for the agent
 *   call that produced this step's output. Mirrors
 *   `executionResult.report` but is directly reachable without
 *   narrowing the union.
 * - `agentUsage` — token counts for this step in isolation. Sum of
 *   all `steps[*].agentUsage` equals the workflow-level `usage`.
 * - `executionResult` — the full `AgentResult` (or custom `run`
 *   return value). Use this when you need `data` / `text` / `error`
 *   alongside the report.
 */
export type StepSnapshot = Readonly<{
  output: unknown;
  skipped: boolean;
  status: "completed" | "skipped" | "failed";
  startedAt: string;
  endedAt: string;
  duration: number;
  attempts: number;
  attemptHistory: AttemptEntry[];
  error?: AIError;
  state: Readonly<Record<string, unknown>>;
  /** Full agent result when the step ran an agent; absent for `run` / skipped / parallel steps. */
  executionResult?: AgentResult<unknown>;
  /** Shortcut: `executionResult.report` when present. */
  agentReport?: AgentReport;
  /** Shortcut: `executionResult.usage` when present. */
  agentUsage?: Usage;
  /** Nested children for parallel steps. */
  steps?: Record<string, StepSnapshot>;
}>;
