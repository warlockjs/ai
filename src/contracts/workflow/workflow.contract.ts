import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ToolContract } from "../../tool/tool";
import type { SnapshotStore } from "../orchestrator/snapshot-store.contract";
import type { WorkflowEventMap } from "../events/event-map.type";
import type { ExecutableContract } from "../executable.contract";
import type { WorkflowResult } from "../result/workflow-result.type";
import type { NextStepResult } from "./next-step-result.type";
import type { RetryConfig } from "./retry-config.type";
import type { StepDefinition, StepOutputSpec } from "./step.contract";
import type { WorkflowContext } from "./workflow-context.type";
import type { WorkflowSnapshot } from "./workflow-snapshot.type";

export type WorkflowEventHandler<K extends keyof WorkflowEventMap> = (
  payload: WorkflowEventMap[K],
) => void;

export type WorkflowEventHandlers = Partial<{
  [K in keyof WorkflowEventMap]: WorkflowEventHandler<K>;
}>;

/**
 * Per-run options for `workflow.execute()`. Carries runtime knobs —
 * everything here is per-call, not per-factory.
 */
export type WorkflowRunOptions<TContext = unknown> = {
  /** Caller-chosen runId. Auto-generated (`wf_<rand>`) when omitted. */
  runId?: string;
  /** Cancellation handle — between-step + in-flight agent abort. */
  signal?: AbortSignal;
  /** Per-execution event handlers (layer 3 of the 3-tier model). */
  on?: WorkflowEventHandlers;
  /**
   * Request-scoped envelope exposed as `ctx.context` to every step.
   * Frozen, never persisted in snapshots — resume callers must
   * supply it fresh. Use for tenancy (`organizationId`), the current
   * user, locale, traceId — anything that scopes the run without
   * being part of the durable input. Defaults to `{}` when omitted.
   */
  context?: TContext;
  /**
   * Opaque caller-supplied identifier that groups multiple `execute()`
   * calls into one conceptual user session / request. Mirrored onto
   * every report node this run produces — including child steps and
   * agents dispatched by steps — so flat queries don't need to walk
   * the tree.
   */
  sessionId?: string;
};

/**
 * Combined-object form accepted by the single-argument overload of
 * `workflow.execute(options)`. Equivalent to `execute(input, options)`
 * with `input` bundled in.
 */
export type WorkflowExecuteOptions<
  TInput = unknown,
  TContext = unknown,
> = WorkflowRunOptions<TContext> & {
  input: TInput;
};

export type WorkflowResumeOptions<TContext = unknown> =
  WorkflowRunOptions<TContext> & {
    /** Bypass signature drift check. Use when you know the workflow
     *  definition change is safe for in-flight snapshots. */
    force?: boolean;
  };

export type WorkflowDefinition<
  TInput = unknown,
  TOutput = unknown,
  TState = Record<string, unknown>,
  TContext = unknown,
> = {
  name: string;
  /**
   * Short natural-language summary of what the workflow does. Surfaced
   * to `ai.supervisor()`'s router prompt and to `workflow.asTool()` as
   * the default tool description.
   */
  description?: string;
  /**
   * Opt-in Standard Schema describing this workflow's input. Purely
   * additive — when set, the workflow can be dropped straight into an
   * agent's `tools: []` array WITHOUT calling `.asTool()`: the runtime
   * derives the LLM tool manifest from `name` + `description` + this
   * schema and dispatches through `execute()`. Omit it and `.asTool()`
   * (which takes its own `inputSchema`) remains the way to expose the
   * workflow as a tool. Never validated by the workflow engine itself —
   * step inputs are still each step's responsibility.
   */
  inputSchema?: StandardSchemaV1<TInput>;
  version?: string;
  steps: StepDefinition<TInput, TState, TContext>[];
  /**
   * Optional durable {@link SnapshotStore} enabling
   * `workflow.resume(runId)`. Construct with
   * `ai.snapshot.{memory,pg,redis}()` — `ai.snapshot.memory()` for
   * dev/tests, `ai.snapshot.redis()` / `ai.snapshot.pg()` for
   * production.
   *
   * Falls back to `ai.config({ defaultSnapshotStore })` when omitted.
   * When neither is set, `resume()` throws and snapshot writes silently
   * skip (current behavior preserved).
   */
  snapshotStore?: SnapshotStore<WorkflowSnapshot>;
  /**
   * Default retry applied to every step that doesn't supply its own
   * `retry`. `undefined` (omitted) means "no retry" — resolves to
   * `{ attempts: 1 }` at runtime. `false` also means no retry; use
   * it to be explicit when you want to lock out retries even for
   * steps that set their own `retry`.
   *
   * Resolution precedence: `step.retry` → `defaultRetry` → `{ attempts: 1 }`.
   */
  defaultRetry?: RetryConfig | false;
  maxSteps?: number;
  loopWarnAfter?: number;
  nextStep?: (
    stepName: string,
    ctx: WorkflowContext<TInput, TState, TContext>,
  ) => NextStepResult | Promise<NextStepResult>;
  output?: StepOutputSpec<TOutput, TInput, TState, TContext>;
  on?: WorkflowEventHandlers;
};

/**
 * Runtime handle returned by `ai.workflow(def)`. Implements the
 * 3-tier event subscription model (factory → instance → per-call)
 * and satisfies `ExecutableContract` so orchestrators / supervisors
 * can invoke any primitive with one uniform signature.
 */
export interface WorkflowInstance<
  TInput = unknown,
  TOutput = unknown,
  TState = Record<string, unknown>,
  TContext = unknown,
> extends ExecutableContract<
  TInput,
  WorkflowRunOptions<TContext>,
  WorkflowResult<TOutput>
> {
  readonly name: string;
  readonly description?: string;
  /**
   * Mirrors {@link WorkflowDefinition.inputSchema} when set — lets the
   * agent tool-collection path auto-adapt this workflow into a
   * `ToolContract` (manifest derived from name + description + this
   * schema) when it appears in `tools: []` without `.asTool()`.
   */
  readonly inputSchema?: StandardSchemaV1<TInput>;
  readonly signature: string;
  readonly version?: string;

  /**
   * Run the workflow. Two interchangeable call shapes:
   *
   * ```ts
   * wf.execute(input);                         // minimal
   * wf.execute(input, { runId, signal, on }); // canonical — mirrors agent.execute
   * wf.execute({ input, runId, signal, on }); // single-object — ergonomic alt
   * ```
   *
   * Runtime picks the combined form when exactly one argument is
   * passed and it is a plain object carrying an `input` property. If
   * your real `input` has a top-level `input` key, prefer the
   * two-arg form to avoid ambiguity.
   */
  execute(
    input: TInput,
    options?: WorkflowRunOptions<TContext>,
  ): Promise<WorkflowResult<TOutput>>;
  execute(
    options: WorkflowExecuteOptions<TInput, TContext>,
  ): Promise<WorkflowResult<TOutput>>;

  resume(
    runId: string,
    options?: WorkflowResumeOptions<TContext>,
  ): Promise<WorkflowResult<TOutput>>;

  on<K extends keyof WorkflowEventMap>(event: K, handler: WorkflowEventHandler<K>): () => void;
  off<K extends keyof WorkflowEventMap>(event: K, handler: WorkflowEventHandler<K>): void;

  /**
   * Wrap this workflow as a `ToolContract` so an agent can invoke it
   * inside its tool-call loop. The tool's `name` mirrors the workflow's
   * `name` (must be set — anonymous workflows throw `WorkflowError`),
   * its `input` is the supplied schema, and its `execute()` runs
   * `workflow.execute(input)`. Workflow errors surface to the agent as
   * `ToolExecutionError` with `cause` set to the original
   * `WorkflowError` subclass.
   *
   * @example
   * const wrapped = wf.asTool({
   *   description: "Run support-ticket triage",
   *   inputSchema: ticketSchema,
   * });
   * const a = ai.agent({ model, tools: [wrapped] });
   */
  asTool<TToolInput = TInput>(options: {
    description?: string;
    inputSchema: StandardSchemaV1<TToolInput>;
  }): ToolContract<TToolInput, TOutput>;
}
