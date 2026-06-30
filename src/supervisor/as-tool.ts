import type {
  SupervisorAsToolOptions,
  SupervisorContract,
} from "../contracts/supervisor/supervisor.contract";
import { SupervisorFailedError } from "../errors";
import { compositeAsTool, type ToolContract } from "../tool/tool";

/**
 * Wrap a `SupervisorContract` as a `ToolContract` so an outer agent
 * can invoke it from its tool-call loop. Mirrors
 * `workflow.asTool()` / `agent.asTool()` — same composition pattern,
 * same error-normalization behavior.
 *
 * Behavior:
 * - The tool's `name` mirrors the supervisor's `name` unless the
 *   caller overrides via `options.name`. Supervisors without a
 *   meaningful name throw `SupervisorFailedError` — an outer agent
 *   can't route to an anonymous tool.
 * - Tool `input` is the supplied schema; the validated value is
 *   coerced to a string (via `String()` for non-string values, or
 *   `JSON.stringify()` for objects) before being forwarded to
 *   `supervisor.execute(input)`. Consumers whose inputs need
 *   richer shaping should pre-format the string themselves.
 * - On `result.error`, the supervisor error is thrown so the tool
 *   wrapper catches it and produces a `ToolExecutionError` with
 *   `cause` set to the original typed supervisor error — the outer
 *   agent sees one uniform error class regardless of which
 *   primitive failed.
 *
 * @example
 * const support = ai.supervisor({ ... });
 * const supportTool = support.asTool({
 *   name: "handle_support_ticket",
 *   description: "Process a customer support ticket end-to-end.",
 *   inputSchema: z.object({ ticket: z.string() }),
 * });
 * const concierge = ai.agent({ model, tools: [supportTool] });
 */
export function asTool<TOutput, TToolInput>(
  supervisorInstance: SupervisorContract<TOutput>,
  options: SupervisorAsToolOptions<TToolInput>,
): ToolContract<TToolInput, TOutput> {
  if (!supervisorInstance.name || typeof supervisorInstance.name !== "string") {
    throw new SupervisorFailedError(
      "supervisor.asTool(): supervisor must have a `name` to be wrapped as a tool",
    );
  }

  return compositeAsTool<TToolInput, TOutput>({
    name: options.name ?? supervisorInstance.name,
    description: options.description ?? `Invoke supervisor "${supervisorInstance.name}" as a tool.`,
    input: options.inputSchema,
    execute: async (input, ctx) => {
      const coerced = coerceInput(input);
      // Relay the outer agent's cancellation signal so cancelling the
      // parent aborts this nested supervisor run — its mid-iteration
      // aborts then propagate into every in-flight child (C2).
      const result = await supervisorInstance.execute(
        coerced,
        ctx?.signal ? { signal: ctx.signal } : undefined,
      );

      if (result.error) {
        // Surface the typed supervisor error — the outer ToolContract
        // wraps it as a ToolExecutionError with `cause` preserved.
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

/**
 * Coerce a tool-input value into the `string` shape supervisor
 * `execute()` expects. Strings pass through; everything else gets
 * JSON-stringified so supervisors invoked via tool wrappers receive a
 * predictable textual input regardless of how the outer agent shaped
 * its call.
 */
function coerceInput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined || value === null) {
    return "";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
