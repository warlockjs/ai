import type { AgentResult } from "../result/agent-result.type";

/**
 * Execution-completion payload for the `onComplete` agent hook (T1
 * of the 2026-05-08 ai-usage/runs/state/cart plan).
 *
 * Fired once at the end of every `agent.execute()` / `agent.stream()`
 * call — regardless of outcome. Audit-log code subscribes here to
 * write one `ai_runs` row per execution with the full report.
 *
 * Distinct from the existing `agent.completed` event: this hook
 * receives a flat payload with the `runId` pre-extracted and the
 * end-to-end duration pre-computed, matching the shape the cost-ledger
 * / audit-log infrastructure consumes. Existing `agent.completed`
 * subscribers are unaffected — both fire.
 *
 * Hook handlers may be sync or async. Errors thrown inside the hook
 * are swallowed so consumer bugs cannot crash the agent loop or
 * interfere with the result returned to the caller.
 *
 * `result.error` is non-null when the run failed — consumers should
 * check it to differentiate completed-vs-failed-vs-cancelled runs
 * (the `result.report.status` field carries the enum).
 */
export type CompleteEvent<TOutput = unknown> = {
  /** Final result. May carry `error` for failed/cancelled runs. */
  result: AgentResult<TOutput>;
  /** Run-scoped identifier (matches `result.report.runId`). */
  runId: string;
  /** End-to-end wall-clock duration in milliseconds. */
  durationMs: number;
};
