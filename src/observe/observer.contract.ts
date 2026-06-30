import type { ExecutionReport } from "../contracts/result/execution-report.type";

/**
 * Generic, panoptic-agnostic observability seam. A flow that resolves
 * to "observed" hands its completed {@link ExecutionReport} to every
 * registered `Observer`. Core depends only on this structural shape and
 * `ExecutionReport` — it never imports any observability package
 * (panoptic, OTel, Langfuse, …). An observability tool implements
 * `Observer` and registers itself via {@link registerObserver}, so
 * `observe: true` / `observeAll` route reports without coupling core to
 * the tool. This is the dependency inversion that keeps the two sides
 * decoupled.
 *
 * The object form of a flow's `observe` option is typed as this same
 * structural `Observer` (NOT a panoptic-specific options type), so a
 * panoptic flow-local collector — which implements `Observer` — can be
 * passed directly.
 *
 * @example
 * const collector: Observer = {
 *   collect(report) {
 *     // forward the finished report to a store / exporter
 *   },
 * };
 * registerObserver(collector);
 */
export interface Observer {
  /**
   * Receive a completed flow's report. May be sync or async — the flow
   * awaits it. A throw is **isolated** (never breaks the run) but no
   * longer **silent**: it is surfaced via `notifyObservers`' `onError`
   * hook, or warned once per observer, so a broken exporter can't vanish
   * from production with no signal (C5).
   */
  collect(report: ExecutionReport): void | Promise<void>;
}
