import type { AIError } from "../errors/ai-error";
import type { BaseReport } from "../contracts/result/base-report.type";
import type { BaseResult } from "../contracts/result/base-result.type";
import type { ExecuteResult } from "../contracts/result/execute-result.type";
import type { RetryConfig } from "../contracts/workflow/retry-config.type";

/**
 * Terminal status of a single batch item. Mirrors the relevant subset
 * of {@link import("../contracts/result/base-report.type").ReportStatus}
 * — an item either ran to completion, failed (after exhausting its
 * retries), or was cancelled before it started because the batch was
 * aborted.
 */
export type BatchItemStatus = "completed" | "failed" | "cancelled";

/**
 * Outcome of running the executable over one input item.
 *
 * `result` is the underlying primitive's own {@link ExecuteResult}
 * (an `AgentResult`, `WorkflowResult`, etc.) when the item ran — it
 * carries the item's own `usage` and `report`. `result` is `undefined`
 * only when the item was `"cancelled"` before it ever executed.
 *
 * `error` is the typed failure cause when `status` is `"failed"` or
 * `"cancelled"`, and `undefined` on success. It mirrors
 * `result?.error` for failed items so callers can branch on the item
 * envelope without reaching into the inner result.
 *
 * @example
 * const batchResult = await ai.batch(summarizer, articles);
 *
 * for (const item of batchResult.items) {
 *   if (item.status === "completed") {
 *     console.log(item.index, item.result?.data);
 *   } else {
 *     console.warn(item.index, item.error?.code);
 *   }
 * }
 */
export type BatchItemResult<TResult extends BaseResult = ExecuteResult> = {
  /** 0-based position of this item in the original `items` array. */
  index: number;
  /** Terminal status of this item. */
  status: BatchItemStatus;
  /**
   * Underlying primitive result when the item ran (success OR failure).
   * `undefined` only for items cancelled before execution started.
   */
  result?: TResult;
  /** Typed failure cause; `undefined` on success. */
  error?: AIError;
  /** Number of attempts spent on this item (1 when no retry happened). */
  attempts: number;
};

/**
 * Batch-specific execution report — a {@link BaseReport} whose
 * `children[]` are the per-item reports, in original item order. The
 * root `usage` is the rolled-up sum of every child's usage, matching
 * the universal rollup invariant ("own cost + sum of children"; a
 * batch has zero own cost — it's pure orchestration).
 */
export type BatchReport = BaseReport & {
  type: "batch";
  /** Total number of items dispatched. */
  total: number;
  /** Count of items that completed successfully. */
  succeeded: number;
  /** Count of items that failed after exhausting retries. */
  failed: number;
  /** Count of items cancelled before they ran (batch aborted). */
  cancelled: number;
};

/**
 * Result returned by `ai.batch(...)`. Satisfies the unified
 * {@link ExecuteResult} envelope — `usage` and `report` are the
 * rolled-up totals across every item — and adds the per-item
 * breakdown under `items`.
 *
 * `data` holds the ordered array of successful items' `result.data`
 * with `undefined` in the slots of failed/cancelled items, so callers
 * that don't care about per-item status can read `data` positionally.
 * `error` is left `undefined` — a batch never fails as a whole; an
 * individual item's failure lives on its `BatchItemResult`.
 *
 * @example
 * const { items, usage, report } = await ai.batch(agent, prompts, {
 *   concurrency: 4,
 *   retry: { attempts: 3, backoff: "exponential" },
 * });
 *
 * console.log(`${report.succeeded}/${report.total} ok, ${usage.total} tokens`);
 */
export type BatchResult<TResult extends BaseResult = ExecuteResult> = Omit<
  ExecuteResult,
  "data" | "report"
> & {
  type: "batch";
  /**
   * Positional outputs: each successful item's `result.data` in
   * original order, with `undefined` in the slots of failed or
   * cancelled items.
   */
  data: (unknown | undefined)[];
  /** Per-item outcomes in original item order. */
  items: BatchItemResult<TResult>[];
  /** Batch-specific report (extends `report` with item counts). */
  report: BatchReport;
};

/**
 * Callback fired once per item as soon as it settles (success or
 * failure), regardless of dispatch order. Useful for streaming
 * progress to a UI or a log without waiting for the whole batch.
 *
 * Fired AFTER an item's retries are exhausted — `item.attempts`
 * reflects the final count. A throw from this hook is swallowed (it
 * must never break the batch); log inside it if you need failures.
 */
export type BatchItemHandler<TResult extends BaseResult = ExecuteResult> = (
  item: BatchItemResult<TResult>,
) => void | Promise<void>;

/**
 * Options for {@link import("./batch").batch}.
 *
 * Every field is optional with a safe default — `ai.batch(exec, items)`
 * runs the whole dataset with unbounded concurrency and no retry.
 */
export type BatchOptions<TResult extends BaseResult = ExecuteResult> = {
  /**
   * Maximum number of items running at once. A positive integer.
   * Defaults to `items.length` (all at once). Values `<= 0` are
   * treated as `1` (fully serial).
   */
  concurrency?: number;
  /**
   * Per-item retry policy, reusing the workflow {@link RetryConfig}
   * semantics (attempts, backoff, `retryOn`, `onRetry`). Applied
   * independently to each item — one item's retries never block
   * another's. Omit (or `attempts: 1`) for no retry.
   */
  retry?: RetryConfig;
  /** Fired once per item the moment it settles. See {@link BatchItemHandler}. */
  onItem?: BatchItemHandler<TResult>;
  /**
   * Cancellation handle. When aborted, in-flight items receive the
   * same signal (so a primitive honoring `signal` stops promptly) and
   * not-yet-started items are reported as `"cancelled"` without
   * running.
   */
  signal?: AbortSignal;
  /**
   * Caller-supplied session identifier propagated onto the batch
   * report and every child item report (lineage), so flat trace
   * queries group the whole batch under one session.
   */
  sessionId?: string;
  /** Optional name for the batch report node. Defaults to `"batch"`. */
  name?: string;
};
