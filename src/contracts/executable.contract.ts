import type { BaseResult } from "./result/base-result.type";

/**
 * Shared contract for all executable AI primitives (agent, workflow, supervisor).
 * All three implement this interface with their specific result types.
 *
 * @example
 * // An agent implements ExecutableContract<string, AgentExecuteOptions, AgentResult<TOutput>>
 * const result = await agent.execute("Summarize this document");
 *
 * @example
 * // A workflow implements ExecutableContract<WorkflowInput, WorkflowOptions, WorkflowResult>
 * const result = await workflow.execute({ topic: "AI trends" });
 */
export interface ExecutableContract<
  TInput,
  TOptions,
  TResult extends BaseResult,
> {
  /**
   * Execute the primitive with the given input and options.
   * Returns a promise that resolves to the typed result.
   */
  execute(input: TInput, options?: TOptions): Promise<TResult>;
}
