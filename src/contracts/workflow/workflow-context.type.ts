import type { AgentResult } from "../result/agent-result.type";
import type { StepSnapshot } from "../result/step-result.type";

/**
 * Context threaded through every step lifecycle phase.
 *
 * Invariants:
 * - `input` is deep-frozen and never changes
 * - `context` is deep-frozen and never changes — request-scoped
 *   envelope (tenancy, current user, locale, traceId). Supplied via
 *   `execute({ context })` / `resume({ context })`. NOT persisted in
 *   snapshots; resume callers must pass it fresh. Defaults to `{}`
 *   when the caller omits it, so readers never need a guard.
 * - `steps` is a frozen map of completed step snapshots
 * - `state` is mutable during a step; frozen into `steps[name].state`
 *   when the step completes
 * - `agentResult` is framework-owned — set when the current step has
 *   an `agent`, reset between steps
 *
 * `input` vs `context` — quick rule: if the field defines *what* to
 * process, it's `input` (durable cause; replayed verbatim on resume).
 * If it defines *who's running it* / *what request scope this is*,
 * it's `context` (per-execution envelope; supplied fresh on resume).
 */
export type WorkflowContext<
  TInput = unknown,
  TState = Record<string, unknown>,
  TContext = unknown,
> = {
  readonly input: TInput;
  readonly context: TContext;
  readonly steps: Readonly<Record<string, StepSnapshot>>;
  state: TState;
  readonly agentResult?: AgentResult<unknown>;
  readonly runId: string;
  readonly signal?: AbortSignal;
  /**
   * Workflow start time as a `Date`. Stable across resume — on a
   * resumed run this reflects the *original* start, not the resume
   * moment. Use `Date.now() - ctx.startedAt.getTime()` for elapsed
   * time, or `ctx.startedAt.toISOString()` when you need the string
   * form (matches `report.startedAt`).
   */
  readonly startedAt: Date;
};
