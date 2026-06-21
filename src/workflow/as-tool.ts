import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { WorkflowInstance } from "../contracts/workflow/workflow.contract";
import { WorkflowError } from "../errors";
import { compositeAsTool, type ToolContract } from "../tool/tool";

/**
 * Wrap a `WorkflowInstance` as a `ToolContract` so an agent can invoke
 * it inside its tool-call loop. Closes the agent-calls-workflow
 * composition gap.
 *
 * Behavior:
 * - Tool `name` mirrors `workflow.name` — workflows without a name throw
 *   `WorkflowError` at wrap time (the agent surface needs a stable id).
 * - Tool `input` is the supplied `inputSchema`; the validated value is
 *   forwarded straight to `workflow.execute(input)`.
 * - On `result.error`, the workflow error is wrapped in
 *   `ToolExecutionError` with `cause` set to the original
 *   `WorkflowError` subclass — the agent's tool-call loop sees a
 *   uniform error class regardless of which primitive failed.
 *
 * @example
 * const wf = workflow({ name: "triage", steps: [...] });
 * const triageTool = asTool(wf, {
 *   description: "Run the support-ticket triage flow",
 *   inputSchema: ticketSchema,
 * });
 * const a = ai.agent({ model, tools: [triageTool] });
 */
export function asTool<TInput, TOutput, TToolInput = TInput>(
  workflowInstance: WorkflowInstance<TInput, TOutput>,
  options: {
    description?: string;
    inputSchema: StandardSchemaV1<TToolInput>;
  },
): ToolContract<TToolInput, TOutput> {
  if (!workflowInstance.name || typeof workflowInstance.name !== "string") {
    throw new WorkflowError(
      "workflow.asTool(): workflow must have a `name` to be wrapped as a tool",
    );
  }

  return compositeAsTool<TToolInput, TOutput>({
    name: workflowInstance.name,
    description: options.description ?? `Invoke workflow "${workflowInstance.name}" as a tool.`,
    input: options.inputSchema,
    execute: async (input) => {
      const result = await workflowInstance.execute(input as unknown as TInput);

      if (result.error) {
        // Throw the workflow error so the surrounding wrapper catches
        // it and produces a `ToolExecutionError` with `cause` pointing
        // back at the original `WorkflowError` subclass — keeps the
        // agent's tool-call loop seeing one uniform error class
        // regardless of which primitive failed.
        throw result.error;
      }

      return {
        data: result.data as TOutput,
        usage: result.usage,
        report: result.report,
      };
    },
  });
}
