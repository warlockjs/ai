import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { BaseReport } from "../contracts/result/base-report.type";
import type { BaseResult } from "../contracts/result/base-result.type";
import type { Usage } from "../contracts/result/usage.type";
import { AgentExecutionError, type AIError } from "../errors";
import { compositeAsTool, type ToolContract } from "./tool";

/**
 * Envelope every executable's `execute()` resolves to. Agent, workflow,
 * and supervisor results all satisfy this shape — `data` / `error`
 * carry the outcome while `usage` and `report` are always present —
 * which is exactly what {@link compositeAsTool} needs to nest the inner
 * run under the outer tool-call node.
 */
type ExecutableEnvelope<TOutput> = BaseResult & {
  data?: TOutput;
  error?: AIError;
  report: BaseReport;
};

/**
 * Structural view of an executable primitive (agent / workflow /
 * supervisor) when it is dropped straight into an agent's `tools: []`
 * array WITHOUT being wrapped via `.asTool()` first.
 *
 * Only the fields the auto-adapt path reads are declared:
 * - `name` — becomes the LLM tool name (required; anonymous executables
 *   are rejected at author time, mirroring `.asTool()`).
 * - `description` — the "when would the model pick this?" line.
 * - `inputSchema` — opt-in Standard Schema typing the tool's arguments.
 *   Surfaced on `WorkflowInstance` / `SupervisorContract` from the new
 *   optional `inputSchema` config field. Absent for agents (which take
 *   a plain string prompt).
 * - `execute` — the dispatch entry every `ExecutableContract` exposes.
 *
 * `invoke` is declared `never` so a `ToolContract` (which HAS `invoke`)
 * can never be mistaken for an executable by the {@link isExecutableTool}
 * guard.
 */
export type ExecutableTool<TInput = unknown, TOutput = unknown> = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: StandardSchemaV1<TInput>;
  execute(input: TInput, options?: unknown): Promise<ExecutableEnvelope<TOutput>>;
  invoke?: never;
};

/**
 * Entry accepted in an agent's `tools: []` array — either an already-
 * built `ToolContract` (the `.asTool()` / `ai.tool()` path) or a raw
 * executable primitive the framework auto-adapts on the caller's
 * behalf.
 */
export type AgentToolEntry<TInput = unknown, TOutput = unknown> =
  | ToolContract<TInput, TOutput>
  | ExecutableTool<TInput, TOutput>;

/**
 * Identity passthrough schema used when an executable is registered as
 * a tool without declaring an `inputSchema`. The model's raw arguments
 * flow straight to `execute()` unchanged — the executable validates
 * internally (workflows via their steps, supervisors/agents via their
 * own input handling).
 */
function passthroughSchema<TInput>(): StandardSchemaV1<TInput> {
  return {
    "~standard": {
      version: 1,
      vendor: "warlock-ai",
      validate: (value: unknown) => ({ value: value as TInput }),
    },
  };
}

/**
 * Type guard distinguishing a raw executable primitive from a built
 * `ToolContract`. An executable exposes `execute()` and no `invoke()`;
 * a `ToolContract` exposes `invoke()`. The `invoke` check is the
 * load-bearing discriminator — `.asTool()`-wrapped composites keep
 * their own `execute` too, so checking `execute` alone is insufficient.
 */
export function isExecutableTool(entry: unknown): entry is ExecutableTool {
  if (!entry || typeof entry !== "object") {
    return false;
  }

  const candidate = entry as { execute?: unknown; invoke?: unknown };

  return typeof candidate.execute === "function" && typeof candidate.invoke !== "function";
}

/**
 * Adapt a raw executable primitive (agent / workflow / supervisor) into
 * a `ToolContract` so an agent can dispatch it inside its tool-call
 * loop WITHOUT the caller writing `.asTool()`. Derives the LLM tool
 * manifest from the executable's own `name` + `description` +
 * (optional) `inputSchema`, then dispatches through the executable's
 * `execute()` — the inner report nests under the outer tool-call node
 * exactly like an explicit `.asTool()` wrapper.
 *
 * Throws `AgentExecutionError` at author time when the executable lacks
 * a usable `name` — the agent's tool surface needs a stable id, the
 * same constraint `.asTool()` enforces.
 */
export function executableToTool<TInput, TOutput>(
  executable: ExecutableTool<TInput, TOutput>,
): ToolContract<TInput, TOutput> {
  if (!executable.name || typeof executable.name !== "string") {
    throw new AgentExecutionError(
      "tools[]: an executable (agent/workflow/supervisor) used as a tool must have a `name`",
      { context: { authoring: true } },
    );
  }

  return compositeAsTool<TInput, TOutput>({
    name: executable.name,
    description: executable.description ?? `Invoke "${executable.name}" as a tool.`,
    input: executable.inputSchema ?? passthroughSchema<TInput>(),
    execute: async (input) => {
      const result = await executable.execute(input);

      if (result.error) {
        // Surface the inner typed error so the surrounding
        // `compositeAsTool` wrapper produces a `ToolExecutionError`
        // with `cause` pointing back at the original subclass — the
        // agent's tool-call loop sees one uniform error class
        // regardless of which primitive failed.
        throw result.error;
      }

      return {
        data: result.data as TOutput,
        usage: result.usage as Usage,
        report: result.report,
      };
    },
  });
}

/**
 * Normalize an agent's `tools: []` array into a uniform
 * `ToolContract[]` for the runtime. Already-built `ToolContract`s
 * (`.asTool()` / `ai.tool()`) pass through untouched; raw executable
 * primitives are auto-adapted via {@link executableToTool}.
 *
 * Returns `undefined` when no tools were supplied so the agent's
 * existing `config.tools ?? []` fallbacks stay byte-identical.
 */
export function normalizeAgentTools(
  tools: ReadonlyArray<AgentToolEntry> | undefined,
): ToolContract<unknown, unknown>[] | undefined {
  if (!tools) {
    return undefined;
  }

  return tools.map((entry) => {
    if (isExecutableTool(entry)) {
      return executableToTool(entry) as ToolContract<unknown, unknown>;
    }

    return entry as ToolContract<unknown, unknown>;
  });
}
