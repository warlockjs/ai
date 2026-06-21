import type { ExecutableContract } from "../executable.contract";
import type { PlannerExecuteOptions } from "./planner-execute-options.type";
import type { PlannerResult } from "./planner-result.type";

/**
 * Runtime handle returned by `ai.planner(config)`.
 *
 * Implements {@link ExecutableContract} alongside `AgentContract`,
 * `WorkflowInstance`, and `SupervisorContract`, so a planner can be
 * dispatched anywhere the framework dispatches an executable — composed
 * as a supervisor intent, an orchestrator capability, or wrapped as a
 * tool for an outer agent.
 *
 * **What it does.** At `execute(goal)` it asks an LLM to GENERATE an
 * ordered plan over the registered capabilities, then executes that
 * plan step-by-step through each capability's own `execute()`,
 * returning the unified `{ data, report, usage, error }` envelope with
 * `report.type === "planner"`. Never throws on runtime failure — errors
 * surface via `result.error`. Authoring-time misconfiguration throws at
 * factory call, not here.
 *
 * @example
 * const research = ai.planner({
 *   name: "research-assistant",
 *   model: ai.openai.model({ name: "gpt-4o" }),
 *   capabilities: [
 *     { name: "search", description: "Search the web", executable: searchAgent },
 *     { name: "write", description: "Draft a summary", executable: writerAgent },
 *   ],
 * });
 *
 * const { data, report, usage, error } = await research.execute(
 *   "Summarize the latest on TypeScript 6",
 * );
 *
 * console.log(report.plan?.summary);
 * for (const executed of report.executedSteps) {
 *   console.log(executed.step.capability, executed.status);
 * }
 */
export interface PlannerContract<TOutput = unknown> extends ExecutableContract<
  string,
  PlannerExecuteOptions<TOutput>,
  PlannerResult<TOutput>
> {
  /** Stable identifier — mirrors the config's `name`. */
  readonly name: string;
  /**
   * Structural fingerprint of the planner definition — name + ordered
   * capability names. Stamped on every report node this planner
   * produces.
   */
  readonly signature: string;

  /**
   * Generate a plan over the configured capabilities and execute it
   * end-to-end. Returns the uniform `{ data, report, usage, error }`
   * shape; runtime failures surface on `result.error`.
   */
  execute(
    goal: string,
    options?: PlannerExecuteOptions<TOutput>,
  ): Promise<PlannerResult<TOutput>>;
}
