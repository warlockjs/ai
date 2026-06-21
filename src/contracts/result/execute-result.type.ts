import type { AIError } from "../../errors/ai-error";
import type { BaseReport } from "./base-report.type";
import type { Usage } from "./usage.type";

/**
 * Unified result envelope returned by every executable primitive —
 * `tool.invoke()`, `agent.execute()`, `workflow.execute()`,
 * `supervisor.execute()`. Per-primitive result types
 * (`AgentResult`, `WorkflowResult`, `SupervisorResult`,
 * `ToolInvokeResult`) all satisfy this shape and add their own
 * discriminator / domain-specific fields.
 *
 * `usage` and `report` are **required** on every invocation, including
 * leaf tools — the framework synthesizes a trivial report for tools
 * (type `"tool"`, empty children, zero usage, real timing) so
 * consumers never have to nil-check the presence of a report.
 *
 * Recursion happens inside `report.children[]` — parent walks the
 * report tree top-down to see every child executable that ran.
 *
 * @example
 * const { data, usage, report, error } = await executable.execute(input);
 *
 * if (error) {
 *   logger.error(error.code, { runId: report.runId, duration: report.duration });
 *   return;
 * }
 *
 * console.log(`spent ${usage.total} tokens across ${report.children.length} children`);
 */
export type ExecuteResult<TData = unknown> = {
  /** Typed output if the execution succeeded. */
  data?: TData;
  /** Typed AI error if the execution failed, undefined on success. */
  error?: AIError;
  /** Rolled-up usage (own + sum of children). Always present. */
  usage: Usage;
  /** Recursive execution report — `report.children[]` carries nested executables. */
  report: BaseReport;
};
