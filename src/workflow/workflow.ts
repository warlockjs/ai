import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { WorkflowEventMap } from "../contracts/events/event-map.type";
import type { ExecutionReport } from "../contracts/result/execution-report.type";
import type { WorkflowResult } from "../contracts/result/workflow-result.type";
import type {
  WorkflowDefinition,
  WorkflowEventHandler,
  WorkflowExecuteOptions,
  WorkflowInstance,
  WorkflowResumeOptions,
  WorkflowRunOptions,
} from "../contracts/workflow/workflow.contract";
import { WorkflowError } from "../errors";
import { notifyObservers } from "../observe/resolve-observers";
import type { ToolContract } from "../tool/tool";
import { asTool } from "./as-tool";
import { WorkflowEmitter } from "./emitter";
import { loadSnapshotForResume, runWorkflow } from "./engine";
import { computeSignature } from "./signature";

/**
 * `ai.workflow(def)` — construct a `WorkflowInstance`. Validates the
 * definition, computes a stable structural signature, and wires up the
 * three-tier event subscription model.
 */
export function workflow<
  TInput = unknown,
  TOutput = unknown,
  TState = Record<string, unknown>,
  TContext = unknown,
>(
  definition: WorkflowDefinition<TInput, TOutput, TState, TContext>,
): WorkflowInstance<TInput, TOutput, TState, TContext> {
  validate(definition);
  const signature = computeSignature(definition);
  const emitter = new WorkflowEmitter(definition.on);

  async function execute(
    inputOrOptions: TInput | WorkflowExecuteOptions<TInput, TContext>,
    maybeOptions?: WorkflowRunOptions<TContext>,
  ): Promise<WorkflowResult<TOutput>> {
    const { input, options } = normalizeExecuteArgs<TInput, TContext>(
      inputOrOptions,
      maybeOptions,
    );
    const runId = options?.runId ?? generateRunId();
    const result = await runWorkflow<TOutput>({
      definition,
      signature,
      emitter,
      input,
      context: options?.context,
      runId,
      signal: options?.signal,
      executionHandlers: options?.on,
      sessionId: options?.sessionId,
    });

    // Route the finished report to any resolved observers (F1/F3).
    // Gated by `definition.observe` + the global observe-all flag;
    // observer errors are swallowed inside `notifyObservers`. Bridge the
    // pre-existing `WorkflowReport = Omit<BaseReport, "type">` drift (the
    // report carries `type: "workflow"` at runtime — engine sets it) so
    // this call site adds no new type error beyond the documented baseline.
    await notifyObservers(definition.observe, result.report as unknown as ExecutionReport);

    return result;
  }

  async function resume(
    runId: string,
    options?: WorkflowResumeOptions<TContext>,
  ): Promise<WorkflowResult<TOutput>> {
    const snapshot = await loadSnapshotForResume({
      definition,
      signature,
      runId,
      options,
    });

    const result = await runWorkflow<TOutput>({
      definition,
      signature,
      emitter,
      input: snapshot.input,
      context: options?.context,
      runId,
      signal: options?.signal,
      executionHandlers: options?.on,
      sessionId: options?.sessionId,
      resumeFrom: snapshot,
    });

    await notifyObservers(definition.observe, result.report as unknown as ExecutionReport);

    return result;
  }

  const instance: WorkflowInstance<TInput, TOutput, TState, TContext> = {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    signature,
    version: definition.version,
    execute,
    resume,
    on<K extends keyof WorkflowEventMap>(event: K, handler: WorkflowEventHandler<K>) {
      return emitter.on(event, handler);
    },
    off<K extends keyof WorkflowEventMap>(event: K, handler: WorkflowEventHandler<K>) {
      emitter.off(event, handler);
    },
    asTool<TToolInput = TInput>(options: {
      description?: string;
      inputSchema: StandardSchemaV1<TToolInput>;
    }): ToolContract<TToolInput, TOutput> {
      return asTool<TInput, TOutput, TToolInput>(instance, options);
    },
  };

  return instance;
}

/**
 * Resolve the overloaded `execute()` call shape. If the caller passed
 * a single plain object with an `input` field, treat it as the
 * combined `WorkflowExecuteOptions`. Otherwise the first arg is the
 * raw workflow input and the second is the run options.
 *
 * Ambiguity note: if your real workflow `input` is itself an object
 * with a top-level `input` key, prefer `execute(rawInput, options)`
 * explicitly — the single-arg detection heuristic would mis-classify
 * it.
 */
function normalizeExecuteArgs<TInput, TContext>(
  inputOrOptions: TInput | WorkflowExecuteOptions<TInput, TContext>,
  maybeOptions: WorkflowRunOptions<TContext> | undefined,
): { input: TInput; options?: WorkflowRunOptions<TContext> } {
  if (
    maybeOptions === undefined &&
    inputOrOptions !== null &&
    typeof inputOrOptions === "object" &&
    "input" in (inputOrOptions as object)
  ) {
    const combined = inputOrOptions as WorkflowExecuteOptions<TInput, TContext>;
    const { input, ...options } = combined;
    return { input, options };
  }

  return { input: inputOrOptions as TInput, options: maybeOptions };
}

function validate<TInput, TOutput, TState, TContext>(
  definition: WorkflowDefinition<TInput, TOutput, TState, TContext>,
): void {
  if (!definition.name || typeof definition.name !== "string") {
    throw new WorkflowError("ai.workflow: `name` is required");
  }

  if (!Array.isArray(definition.steps) || definition.steps.length === 0) {
    throw new WorkflowError(`ai.workflow("${definition.name}"): at least one step is required`);
  }

  const seen = new Set<string>();
  const walk = (name: string) => {
    if (seen.has(name)) {
      throw new WorkflowError(`ai.workflow("${definition.name}"): duplicate step name "${name}"`);
    }
    seen.add(name);
  };

  for (const step of definition.steps) {
    walk(step.name);

    if (step.parallel) {
      for (const child of step.parallel) {
        walk(child.name);
      }
    }
  }
}

function generateRunId(): string {
  // Non-crypto random — adequate for ephemeral workflow runs.
  return `wf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
