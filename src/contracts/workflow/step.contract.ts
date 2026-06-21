import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { AgentExecuteOptions } from "../agent/agent-options.type";
import type { AgentContract } from "../agent/agent.contract";
import type { AIError } from "../../errors";
import type { NextStepResult } from "./next-step-result.type";
import type { RetryConfig } from "./retry-config.type";
import type { WorkflowContext } from "./workflow-context.type";

/**
 * Step-local event payloads. Fired on per-step `on: { ... }` handlers
 * in addition to the workflow-level `workflow.step.*` events — useful
 * when you want a handler scoped to one step only.
 */
export type StepLocalEvents = {
  /** Before the step's lifecycle starts (after `skip` evaluates false). */
  starting: { step: string };
  /** Fired before every retry attempt (not the first). */
  retrying: {
    step: string;
    attempt: number;
    totalAttempts: number;
    lastError: unknown;
  };
  /** Fired once after all retry attempts are exhausted. */
  failed: { step: string; error: unknown; attempts: number };
  /** Fired when the step completes successfully. */
  completed: { step: string; output: unknown; duration: number };
};

/**
 * Input built by `input(ctx)` when the step has an `agent`. Carries
 * the prompt string plus any per-call agent options (history,
 * attachments, placeholders, per-call output schema, etc.).
 */
export type StepAgentInput = AgentExecuteOptions<unknown> & {
  /** Prompt text passed to `agent.execute(prompt, options)`. */
  prompt: string;
};

/**
 * Output extraction spec. `extract(ctx)` reads from `ctx.agentResult`
 * (for agent steps), the step's `run()` return value, or `ctx.state`
 * and produces the value stored at `step.output` in the snapshot.
 *
 * If `schema` is supplied, the extracted value is validated against it;
 * validation failures throw `SchemaValidationError` and trip the
 * step's retry logic (a retryable failure).
 */
export type StepOutputSpec<
  TOutput = unknown,
  TInput = unknown,
  TState = Record<string, unknown>,
  TContext = unknown,
> = {
  extract: (
    ctx: WorkflowContext<TInput, TState, TContext>,
  ) => TOutput | Promise<TOutput>;
  schema?: StandardSchemaV1<TOutput>;
};

/**
 * Static declaration of a single workflow step.
 *
 * **Step kind.** Exactly one of `run`, `agent`, or `parallel` must be
 * set. `input` is required when `agent` is set. The step factory
 * (`ai.step`) throws a `WorkflowError` at authoring time when these
 * invariants are broken.
 *
 * **Lifecycle order (happy path).**
 * ```
 * skip? → before? → (run | agent | parallel) → output?.extract (+ schema) → after?
 *                                                                            ↓
 *                                                                         nextStep?
 * ```
 * Retry wraps the middle block (`before → run|agent → output → after`);
 * `skip` / `nextStep` / `onCancel` sit outside the retry loop.
 */
export type StepDefinition<
  TInput = unknown,
  TState = Record<string, unknown>,
  TContext = unknown,
> = {
  /**
   * Unique step name. Must be unique within the workflow (including
   * across parallel children). Used as the key in `ctx.steps` and
   * `report.steps`, as the routing target for `{ goto: "..." }`, and
   * as the identifier in every event payload.
   */
  name: string;

  /**
   * Skip guard. Evaluated BEFORE `before`. Returns `true` to bypass
   * the step entirely — `before` / `run` / `agent` / `output` / `after`
   * are never invoked, the snapshot is marked `{ skipped: true,
   * status: "skipped" }`, and `nextStep` still fires so routing can
   * react to the skip.
   */
  skip?: (ctx: WorkflowContext<TInput, TState, TContext>) => boolean | Promise<boolean>;

  /**
   * Pre-work hook. Runs inside the retry loop before `run` / `agent`.
   * Mutate `ctx.state` here for setup (fetching prerequisites, setting
   * derived values, validating preconditions). A throw fails the
   * attempt and triggers retry (if configured).
   */
  before?: (ctx: WorkflowContext<TInput, TState, TContext>) => void | Promise<void>;

  /**
   * Core work for non-agent steps. Receives the context and may return
   * any value; the return value is exposed to `output.extract` via
   * `ctx.agentResult`. Mutually exclusive with `agent` and `parallel`.
   */
  run?: (ctx: WorkflowContext<TInput, TState, TContext>) => unknown;

  /**
   * Agent to execute for this step. Mutually exclusive with `run` and
   * `parallel`. The agent receives `input(ctx)`'s prompt (and any
   * options from the same call); its `AgentResult` is stored on
   * `ctx.agentResult` for downstream `output.extract` / `after` use
   * and aggregated into `report.steps[name].executionResult`.
   */
  agent?: AgentContract<unknown>;

  /**
   * Builds the prompt + per-call options for `agent`. Required when
   * `agent` is set. Runs once per retry attempt so the prompt can
   * incorporate fresh context (e.g., loop-back feedback on
   * `ctx.state.qaFeedback`).
   */
  input?: (ctx: WorkflowContext<TInput, TState, TContext>) => StepAgentInput | Promise<StepAgentInput>;

  /**
   * Output extraction spec. Runs after `run` / `agent`. Without this
   * the step's `output` in the snapshot is `undefined`. A throw (or
   * schema validation failure) fails the attempt and triggers retry.
   */
  output?: StepOutputSpec<unknown, TInput, TState, TContext>;

  /**
   * Post-work hook. Runs inside the retry loop AFTER `output.extract`.
   * Intended for side effects (save to DB, send notification, fire
   * webhook). A throw fails the attempt and triggers retry — so keep
   * `after` work idempotent.
   */
  after?: (ctx: WorkflowContext<TInput, TState, TContext>) => void | Promise<void>;

  /**
   * Step-level routing. Runs OUTSIDE the retry loop, once per step
   * completion — but ONLY for `completed` and `skipped` outcomes. A
   * step whose retries are exhausted (`failed`) bypasses `nextStep`
   * and goes through `onFailure` (if defined) or halts the workflow.
   * Return `{ goto, end, void }` — step-level wins over workflow-level;
   * `void` falls through. Errors here are NOT retried: routing is
   * authoritative, so a throw terminates the workflow with
   * `RoutingError`.
   */
  nextStep?: (ctx: WorkflowContext<TInput, TState, TContext>) => NextStepResult | Promise<NextStepResult>;

  /**
   * Failure-routing hook. Runs OUTSIDE the retry loop, once after all
   * retry attempts are exhausted, before the workflow halts. Return:
   * - `{ goto: "name" }` to redirect to a recovery step (workflow
   *   continues; final status becomes `completed` if recovery succeeds)
   * - `{ end: true }` to terminate cleanly without an error
   * - `void` (or omit) to halt the workflow with the original
   *   `StepFailedError` — same as if no `onFailure` were defined
   *
   * The step's snapshot retains `status: "failed"` and `error` for
   * forensic trace even when `onFailure` recovers the run. Errors
   * thrown from `onFailure` are NOT retried — they terminate the
   * workflow with `RoutingError` (mirrors `nextStep`).
   */
  onFailure?: (
    ctx: WorkflowContext<TInput, TState, TContext>,
    error: AIError,
  ) => NextStepResult | Promise<NextStepResult>;

  /**
   * Cancellation cleanup. Runs best-effort when the workflow is
   * aborted while this step is in-flight. Typical use: release a
   * reservation, flush a partial write, cancel an external job. Errors
   * thrown from `onCancel` are swallowed + logged — never rethrown.
   */
  onCancel?: (ctx: WorkflowContext<TInput, TState, TContext>) => void | Promise<void>;

  /**
   * Retry configuration. Overrides workflow-level `defaultRetry`.
   * `false` disables retry entirely. See `RetryConfig` for backoff
   * options. Retry wraps `before → run|agent → output → after`;
   * `AbortError` short-circuits the loop.
   */
  retry?: RetryConfig | false;

  /**
   * Parallel children — run concurrently, share `ctx.state`
   * (last-write-wins). Mutually exclusive with `run` and `agent`.
   * The parent's snapshot is atomic: written only after every child
   * settles. Children are addressable at both `ctx.steps.<child>` and
   * `ctx.steps.<parent>.steps.<child>`.
   */
  parallel?: StepDefinition<TInput, TState, TContext>[];

  /**
   * Per-step event handlers — fires alongside the workflow-level
   * `workflow.step.*` events. Scope is step-local (no `workflow.`
   * prefix); payload includes the step name for symmetry with the
   * workflow-level events.
   */
  on?: Partial<{
    [K in keyof StepLocalEvents]: (payload: StepLocalEvents[K]) => void;
  }>;
};
