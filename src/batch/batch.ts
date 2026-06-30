import type { BaseReport } from "../contracts/result/base-report.type";
import { REPORT_SCHEMA_VERSION } from "../contracts/result/base-report.type";
import type { BaseResult } from "../contracts/result/base-result.type";
import type { ExecutableContract } from "../contracts/executable.contract";
import type { ExecuteResult } from "../contracts/result/execute-result.type";
import type { Usage } from "../contracts/result/usage.type";
import { accumulateCost } from "../utils/compute-cost";
import { generateRunId } from "../utils/generate-run-id";
import { stampReportLineage } from "../utils/stamp-report-lineage";
import type {
  BatchItemResult,
  BatchOptions,
  BatchReport,
  BatchResult,
} from "./batch.type";
import { runBatchItem } from "./run-batch-item";
import { runWithConcurrency } from "./run-with-concurrency";

/** Batch size above which an unset (unbounded) concurrency warns once (D5). */
const BATCH_UNBOUNDED_WARN_THRESHOLD = 50;

/** Process-lifetime flag so the unbounded-batch warning fires at most once. */
let warnedUnboundedBatch = false;

/**
 * Run an executable AI primitive (agent, workflow, supervisor, tool,
 * or anything satisfying {@link ExecutableContract}) over a dataset
 * with bounded concurrency and per-item retry, returning per-item
 * outcomes plus rolled-up usage and a walkable report tree.
 *
 * **Role.** The fan-out primitive of `@warlock.js/ai`. Where an agent
 * runs once, `batch` runs the SAME executable N times — once per item
 * — and aggregates the results into the unified {@link ExecuteResult}
 * envelope, so a batch slots into cost dashboards and trace tooling
 * exactly like a single run does.
 *
 * **Isolation.** Items are independent: one item's failure (after its
 * retries are exhausted) never cancels a sibling, and the batch as a
 * whole never rejects — failures live on each {@link BatchItemResult}.
 * Reach for `result.report.failed` / `item.status` to inspect them.
 *
 * **Usage rollup.** `result.usage` and `result.report.usage` sum every
 * item's usage, satisfying the universal rollup invariant ("own cost
 * + sum of children"; a batch has zero own cost). Each item's own
 * report is attached under `report.children[]`, in original item
 * order, so a trace walker sees every run.
 *
 * @example
 * const result = await batch(summarizer, articles, {
 *   concurrency: 4,
 *   retry: { attempts: 3, backoff: "exponential" },
 *   onItem: (item) => log.info("batch", "item", "settled", { index: item.index }),
 * });
 *
 * console.log(`${result.report.succeeded}/${result.report.total} ok`);
 * console.log(`${result.usage.total} tokens total`);
 */
export async function batch<TInput, TOptions, TResult extends BaseResult = ExecuteResult>(
  executable: ExecutableContract<TInput, TOptions, TResult>,
  items: readonly TInput[],
  options: BatchOptions<TResult> = {},
): Promise<BatchResult<TResult>> {
  return new BatchRun(executable, items, options).run();
}

/**
 * Per-call orchestration state for one {@link batch} invocation.
 * Instantiated fresh inside the factory so the mutable accumulators
 * (`results`, `usage`) are never shared across batches. Unexported —
 * callers only ever see the plain {@link BatchResult}.
 */
class BatchRun<TInput, TOptions, TResult extends BaseResult> {
  private readonly runId: string;
  private readonly results: BatchItemResult<TResult>[];
  private readonly startedAt = new Date().toISOString();
  private readonly startPerf = performance.now();

  public constructor(
    private readonly executable: ExecutableContract<TInput, TOptions, TResult>,
    private readonly items: readonly TInput[],
    private readonly options: BatchOptions<TResult>,
  ) {
    this.runId = generateRunId("batch");
    this.results = new Array<BatchItemResult<TResult>>(items.length);
  }

  /**
   * Dispatch every item through the concurrency pool, then assemble
   * the rolled-up {@link BatchResult}. Runs once per `batch()` call.
   */
  public async run(): Promise<BatchResult<TResult>> {
    const concurrency = this.resolveConcurrency();

    await runWithConcurrency(this.items.length, concurrency, (index) =>
      this.processItem(index),
    );

    return this.buildResult();
  }

  /**
   * Resolve the effective concurrency from {@link BatchOptions.concurrency}
   * (D5). An explicit number or `"unbounded"` is honored as-is; an omitted
   * value runs unbounded for back-compat but warns once (outside tests)
   * for a large batch so an accidental all-at-once run is visible.
   */
  private resolveConcurrency(): number {
    const configured = this.options.concurrency;

    if (configured === "unbounded") {
      return this.items.length;
    }
    if (typeof configured === "number") {
      return configured;
    }

    if (
      this.items.length > BATCH_UNBOUNDED_WARN_THRESHOLD &&
      !warnedUnboundedBatch &&
      !process.env.VITEST &&
      process.env.NODE_ENV !== "test"
    ) {
      warnedUnboundedBatch = true;
      console.warn(
        `[warlock-ai] ai.batch() is running ${this.items.length} items with unbounded concurrency (no \`concurrency\` set). ` +
          'Each concurrent item consumes tokens/quota/memory — pass an explicit `concurrency` cap, or `concurrency: "unbounded"` to silence this.',
      );
    }

    return this.items.length;
  }

  /**
   * Run a single item with retry, record it positionally, then fire
   * the `onItem` hook. A throw from the hook is swallowed — a progress
   * callback must never break the batch.
   */
  private async processItem(index: number): Promise<void> {
    const item = await runBatchItem({
      index,
      input: this.items[index] as TInput,
      executable: this.executable,
      retry: this.options.retry,
      signal: this.options.signal,
    });

    this.results[index] = item;

    if (this.options.onItem) {
      try {
        await this.options.onItem(item);
      } catch {
        // A progress hook must never break the batch — swallow its throw.
      }
    }
  }

  /**
   * Fold the per-item outcomes into rolled-up usage, the child report
   * list, and the final {@link BatchResult}, then stamp lineage across
   * the whole subtree so every child shares this batch's root run id.
   */
  private buildResult(): BatchResult<TResult> {
    const usage: Usage = { input: 0, output: 0, total: 0 };
    const children: BaseReport[] = [];
    const data: (unknown | undefined)[] = new Array(this.items.length).fill(undefined);

    let succeeded = 0;
    let failed = 0;
    let cancelled = 0;

    for (const item of this.results) {
      if (item.status === "completed") {
        succeeded += 1;
      } else if (item.status === "failed") {
        failed += 1;
      } else {
        cancelled += 1;
      }

      const itemResult = item.result;
      if (itemResult) {
        this.mergeUsage(usage, itemResult.usage);

        if ("report" in itemResult && itemResult.report) {
          children.push(itemResult.report as BaseReport);
        }

        if (item.status === "completed" && "data" in itemResult) {
          data[item.index] = (itemResult as { data?: unknown }).data;
        }
      }
    }

    const report = this.buildReport(usage, children, { succeeded, failed, cancelled });

    stampReportLineage(report, {
      rootRunId: this.runId,
      sessionId: this.options.sessionId,
    });

    return {
      type: "batch",
      data,
      usage,
      report,
      items: this.results,
    };
  }

  /**
   * Add a child's usage into the running batch total. Scalar token
   * channels sum directly; the optional cost breakdown merges via
   * {@link accumulateCost} so a single unpriced child can't erase the
   * cost of priced siblings. Optional token sub-channels
   * (`cachedTokens`, etc.) accumulate only when some child reports
   * them, preserving the "never reported anywhere" signal.
   */
  private mergeUsage(target: Usage, child: Usage): void {
    target.input += child.input;
    target.output += child.output;
    target.total += child.total;

    if (child.cachedTokens !== undefined) {
      target.cachedTokens = (target.cachedTokens ?? 0) + child.cachedTokens;
    }

    if (child.reasoningTokens !== undefined) {
      target.reasoningTokens = (target.reasoningTokens ?? 0) + child.reasoningTokens;
    }

    if (child.cacheWriteTokens !== undefined) {
      target.cacheWriteTokens = (target.cacheWriteTokens ?? 0) + child.cacheWriteTokens;
    }

    const mergedCost = accumulateCost(target.cost, child.cost);
    if (mergedCost !== undefined) {
      target.cost = mergedCost;
    }
  }

  /**
   * Build the batch's own {@link BatchReport} node. `parentRunId` /
   * `rootRunId` are placeholders here — {@link stampReportLineage}
   * rewrites them across the whole subtree right after.
   */
  private buildReport(
    usage: Usage,
    children: BaseReport[],
    counts: { succeeded: number; failed: number; cancelled: number },
  ): BatchReport {
    const status = counts.failed > 0 || counts.cancelled > 0 ? "failed" : "completed";

    return {
      runId: this.runId,
      rootRunId: this.runId,
      name: this.options.name ?? "batch",
      type: "batch",
      status,
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      duration: performance.now() - this.startPerf,
      usage,
      children,
      total: this.items.length,
      succeeded: counts.succeeded,
      failed: counts.failed,
      cancelled: counts.cancelled,
      reportSchemaVersion: REPORT_SCHEMA_VERSION,
    };
  }
}
