import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { BaseReport } from "../contracts/result/base-report.type";
import type { Usage } from "../contracts/result/usage.type";
import type { ToolConfig, ToolContext } from "../contracts/tool.contract";
import { AIError, SchemaValidationError, ToolExecutionError } from "../errors";
import { generateRunId } from "../utils/generate-run-id";

/**
 * Degraded `ToolContext` supplied when no caller threads one through
 * (`tool.invoke(input)` standalone, batch scripts, tests). Per
 * decisions §35 — mutations on the empty bag are harmless no-ops;
 * production paths under a supervisor receive a real ctx with the
 * iteration's shared bag.
 */
function defaultToolContext(): ToolContext {
  return { artifacts: {} };
}

const EMPTY_USAGE: Usage = Object.freeze({ input: 0, output: 0, total: 0 });

/**
 * Result returned by `ToolContract.invoke()`.
 *
 * **Canonical destructure:** `const { data, usage, report, error }` —
 * matches every other executable (`AgentResult`, `WorkflowResult`,
 * `SupervisorResult`) so parent agents can treat every tool dispatch
 * uniformly.
 *
 * **Shape.** `data` / `error` carry the outcome; `usage` and `report`
 * are always present. For leaf tools, `usage` is zero and `report`
 * is a framework-synthesized {@link BaseReport} (`type: "tool"`,
 * `children: []`, real timing) so parents never have to nil-check.
 * For composites wrapped via `asTool()`, `usage` and `report` mirror
 * the inner primitive's — the nested tree lives in `report.children`.
 *
 * @example
 * const result = await myTool.invoke({ city: "Cairo" });
 * if (result.error) console.error(result.error.message);
 * else console.log(result.data, result.report.duration);
 */
export type ToolInvokeResult<TOutput> = {
  /** Successfully-returned output. Undefined if execution or validation failed. */
  data?: TOutput;
  /** Typed AI error produced by validation or execute(), if any. */
  error?: AIError;
  /** Rolled-up usage (zero for leaf tools, populated for composites). */
  usage: Usage;
  /** Recursive execution report — `report.children` carries nested executables. */
  report: BaseReport;
};

/**
 * A `ToolConfig` augmented with a safe `invoke()` entry point for the agent runtime.
 *
 * @example
 * const wrapped: ToolContract<{ city: string }, { temp: number }> = tool(contract);
 * const result = await wrapped.invoke({ city: "Cairo" });
 */
export interface ToolContract<TInput = unknown, TOutput = unknown> extends ToolConfig<
  TInput,
  TOutput
> {
  /**
   * Agent-runtime entry point. Validates raw input against the tool's schema,
   * calls execute(), catches errors, and reports duration.
   * Never throws — errors surface in the returned `error` field as
   * typed `AIError` subclasses.
   *
   * The optional second argument is a `ToolContext` (Phase 5 /
   * decisions §35) — when supplied, threaded into `execute(input, ctx)`
   * so tools can write system-only side data into `ctx.artifacts`.
   * Standalone callers may omit it; the framework supplies a
   * degraded `{ artifacts: {} }` so single-arg legacy handlers keep
   * working unchanged.
   *
   * @example
   * const result = await myTool.invoke(rawLLMArgs);
   * if (result.error) handleError(result.error);
   */
  invoke(rawInput: unknown, ctx?: ToolContext): Promise<ToolInvokeResult<TOutput>>;
}

/**
 * Wraps a raw `ToolConfig` and adds a safe `invoke()` method for the agent runtime.
 * The returned object preserves all original contract fields unchanged.
 *
 * Error categorization:
 * - Input schema rejects model args → `SchemaValidationError` (issues preserved).
 * - Schema's `validate()` itself throws → `SchemaValidationError` wrapping the cause.
 * - `execute()` throws → `ToolExecutionError` wrapping the cause.
 *
 * @example
 * const weatherTool = tool({
 *   name: "getWeather",
 *   description: "Fetch current weather for a city",
 *   input: z.object({ city: z.string() }),
 *   execute: async ({ city }) => ({ temp: 72 }),
 * });
 *
 * const result = await weatherTool.invoke({ city: "Cairo" });
 */
/**
 * Internal factory for `asTool()` wrappers on composite primitives
 * (agent / workflow / supervisor). Unlike the public `tool()` factory
 * (which synthesizes a leaf `BaseReport` every time), this variant
 * lets the composite's own `ExecuteResult` flow through: the inner
 * primitive's `report` becomes the sole child of the outer tool-call
 * node, and the inner `usage` is surfaced so parents can roll it up.
 *
 * The caller supplies `execute()` returning `{ data, usage, report }`
 * from the composite's own `execute()` method. Validation failures
 * and thrown errors still produce a synthesized failed leaf report —
 * the inner-report propagation is strictly a success-path concern.
 *
 * Not exported from the package barrel — used by `agent.asTool()`,
 * `workflow.asTool()`, `supervisor.asTool()` only.
 */
export function compositeAsTool<TInput, TOutput>(contract: {
  name: string;
  description?: string;
  version?: string;
  meta?: ToolConfig["meta"];
  input: StandardSchemaV1<TInput>;
  /**
   * Runs the underlying composite and returns its full envelope. The
   * optional `ctx` relays the outer run's cancellation `signal` so a
   * cancelled parent aborts the nested primitive instead of letting it
   * outlive the cancellation (C2).
   */
  execute: (input: TInput, ctx?: ToolContext) => Promise<{
    data?: TOutput;
    error?: AIError;
    usage: Usage;
    report: BaseReport;
  }>;
}): ToolContract<TInput, TOutput> {
  // The underlying `ToolConfig<TInput, TOutput>.execute` is typed as
  // `(input) => Promise<TOutput>`, but composite wrappers return an
  // envelope object instead. Surface a contract-shaped view that
  // extracts `.data` on demand for any code that still treats this
  // like a plain tool.
  const publicExecute = async (input: TInput): Promise<TOutput> => {
    const envelope = await contract.execute(input);
    if (envelope.error) throw envelope.error;
    return envelope.data as TOutput;
  };

  return {
    name: contract.name,
    description: contract.description ?? `Composite tool "${contract.name}".`,
    meta: contract.meta,
    input: contract.input,
    execute: publicExecute,

    async invoke(rawInput: unknown, ctx?: ToolContext): Promise<ToolInvokeResult<TOutput>> {
      // Composite tools (asTool-wrapped agent/workflow/supervisor) run in
      // their own state/scope — the ctx's `artifacts` bag is NOT shared
      // into the inner primitive (an inner supervisor gets a fresh bag).
      // The cancellation `signal`, however, IS relayed (below, into
      // `contract.execute`) so a cancelled outer run aborts the nested
      // primitive instead of letting it outlive the cancellation (C2).
      const startedAtDate = new Date();
      const start = performance.now();
      const runId = generateRunId("tool");

      const failLeaf = (error: AIError): ToolInvokeResult<TOutput> => {
        const endedAt = new Date().toISOString();
        const duration = performance.now() - start;
        return {
          error,
          usage: EMPTY_USAGE,
          report: {
            runId,
            rootRunId: runId,
            name: contract.name,
            version: contract.version,
            type: "tool",
            status: "failed",
            startedAt: startedAtDate.toISOString(),
            endedAt,
            duration,
            usage: EMPTY_USAGE,
            children: [],
          },
        };
      };

      let validationResult: StandardSchemaV1.Result<TInput>;
      try {
        const schema = contract.input as StandardSchemaV1<TInput>;
        validationResult = await schema["~standard"].validate(rawInput);
      } catch (thrown) {
        const message = thrown instanceof Error ? thrown.message : String(thrown);
        return failLeaf(
          new SchemaValidationError(
            `Schema validation threw for tool "${contract.name}": ${message}`,
            { cause: thrown, context: { toolName: contract.name } },
          ),
        );
      }

      if (validationResult.issues) {
        const summary = validationResult.issues.map((issue) => issue.message).join("; ");
        return failLeaf(
          new SchemaValidationError(`Validation failed: ${summary}`, {
            issues: validationResult.issues,
            context: { toolName: contract.name },
          }),
        );
      }

      try {
        const composite = await contract.execute(validationResult.value, ctx);
        // Surface the inner primitive's full envelope. The outer
        // ToolInvokeResult carries the composite's usage and report
        // verbatim; the agent runtime nests the report as a child of
        // the tool-dispatch node it records.
        return {
          data: composite.data,
          error: composite.error,
          usage: composite.usage,
          report: composite.report,
        };
      } catch (thrown) {
        const message = thrown instanceof Error ? thrown.message : String(thrown);
        return failLeaf(
          new ToolExecutionError(message, {
            cause: thrown,
            toolName: contract.name,
          }),
        );
      }
    },
  };
}

export function tool<TInput, TOutput>(
  contract: ToolConfig<TInput, TOutput>,
): ToolContract<TInput, TOutput> {
  return {
    ...contract,

    async invoke(rawInput: unknown, ctx?: ToolContext): Promise<ToolInvokeResult<TOutput>> {
      const startedAtDate = new Date();
      const start = performance.now();
      const runId = generateRunId("tool");
      const handlerCtx = ctx ?? defaultToolContext();

      const finish = (partial: { data?: TOutput; error?: AIError }): ToolInvokeResult<TOutput> => {
        const endedAt = new Date().toISOString();
        const duration = performance.now() - start;
        const status: BaseReport["status"] = partial.error ? "failed" : "completed";
        const report: BaseReport = {
          runId,
          rootRunId: runId,
          name: contract.name,
          version: contract.version,
          type: "tool",
          status,
          startedAt: startedAtDate.toISOString(),
          endedAt,
          duration,
          usage: EMPTY_USAGE,
          children: [],
        };

        return {
          ...partial,
          usage: EMPTY_USAGE,
          report,
        };
      };

      let validationResult: StandardSchemaV1.Result<TInput>;
      if (contract.input) {
        try {
          validationResult = await contract.input["~standard"].validate(rawInput);
        } catch (thrown) {
          const message = thrown instanceof Error ? thrown.message : String(thrown);

          return finish({
            error: new SchemaValidationError(
              `Schema validation threw for tool "${contract.name}": ${message}`,
              { cause: thrown, context: { toolName: contract.name } },
            ),
          });
        }
      } else {
        // `input` is optional on ToolConfig — this is a no-argument tool
        // (e.g. view_cart, checkout). With no schema there is nothing to
        // validate, so pass the raw model args straight to execute()
        // instead of dereferencing a missing schema's `~standard`.
        validationResult = { value: rawInput as TInput };
      }

      if (validationResult.issues) {
        const summary = validationResult.issues.map((issue) => issue.message).join("; ");

        return finish({
          error: new SchemaValidationError(`Validation failed: ${summary}`, {
            issues: validationResult.issues,
            context: { toolName: contract.name },
          }),
        });
      }

      try {
        const output = await contract.execute(validationResult.value, handlerCtx);
        return finish({ data: output });
      } catch (thrown) {
        const message = thrown instanceof Error ? thrown.message : String(thrown);

        return finish({
          error: new ToolExecutionError(message, {
            cause: thrown,
            toolName: contract.name,
          }),
        });
      }
    },
  };
}
