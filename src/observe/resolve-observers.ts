import { isNestedRun } from "../utils/run-context";
import { getObservers, isObserveAll } from "./observer-registry";
import type { Observer } from "./observer.contract";

/**
 * The value a flow's `observe` config option may take. Additive and
 * gated — when `undefined` (the default), behavior follows the global
 * observe-all flag, so a flow that never sets `observe` behaves exactly
 * as before unless an observability tool turned observe-all on.
 *
 * - `true`  → route this flow to the globally registered observers,
 *   even when observe-all is off.
 * - `false` → opt this flow out entirely, even when observe-all is on.
 * - an {@link Observer} object → a flow-local collector; only this flow's
 *   report is routed, and only to it (the global observers are skipped).
 *   A panoptic flow-local collector implements `Observer`, so it can be
 *   passed here directly — core stays panoptic-agnostic.
 * - `undefined` → follow the global observe-all flag.
 */
export type FlowObserveOption = boolean | Observer;

/**
 * Resolve a flow's `observe` option into the concrete list of
 * {@link Observer}s to notify with that flow's completed report:
 *
 * - `false` → `[]` (opted out).
 * - `true` → the globally registered observers.
 * - an `Observer` object → just that one (flow-local).
 * - `undefined` → the globally registered observers when observe-all is
 *   on AND this is a ROOT run, otherwise `[]`.
 *
 * Reads the ambient {@link currentRunFrame} for the observe-all path:
 * flows call it at completion, so a present frame means the run is nested
 * inside an orchestration callback and is already attached to its parent's
 * report tree — self-routing it again would double-count it as a separate
 * top-level trace (and double its tokens/cost in the aggregate). Explicit
 * `observe: true` / an `Observer` still route regardless of nesting.
 */
export function resolveObservers(observe: FlowObserveOption | undefined): readonly Observer[] {
  if (observe === false) {
    return [];
  }

  if (observe === true) {
    return getObservers();
  }

  if (observe !== undefined) {
    return [observe];
  }

  // Observe-all captures ROOT runs only. A run nested inside any parent
  // capture (orchestration callback, supervisor member dispatch, workflow
  // step) already nests in its parent's report, so routing it here too would
  // duplicate it as a standalone top-level trace.
  return isObserveAll() && !isNestedRun() ? getObservers() : [];
}

/**
 * Observers whose `collect()` already threw once — so the isolate-but-
 * surface warning fires at most once per observer object, never spamming
 * the log when every flow report hits the same broken exporter. Keyed by
 * object identity via a {@link WeakSet} so a discarded observer is GC'd
 * without leaking. Mirrors panoptic's per-exporter `warnedExporters`.
 */
const warnedObservers = new WeakSet<Observer>();

/**
 * Route a completed flow report to every observer the flow's `observe`
 * option resolves to. Each `collect` is awaited so async exporters
 * finish before the flow returns; a throw is **isolated** (never breaks
 * the run) but no longer **silent** — it is surfaced via `onError` when
 * supplied, otherwise a `console.warn` once per observer. A broken
 * observer/exporter must not disappear from production with no signal
 * (C5). Adopts the isolate-but-surface pattern panoptic's collector
 * already uses for exporters.
 */
export async function notifyObservers(
  observe: FlowObserveOption | undefined,
  report: Parameters<Observer["collect"]>[0],
  onError?: (error: unknown, observer: Observer) => void,
): Promise<void> {
  for (const observer of resolveObservers(observe)) {
    try {
      await observer.collect(report);
    } catch (error) {
      surfaceObserverError(observer, error, onError);
    }
  }
}

/**
 * Surface an isolated observer failure without ever rethrowing into the
 * flow. Prefers the caller-supplied `onError` (itself guarded so a
 * throwing handler can't escape); otherwise warns once per observer.
 */
function surfaceObserverError(
  observer: Observer,
  error: unknown,
  onError?: (error: unknown, observer: Observer) => void,
): void {
  if (onError) {
    try {
      onError(error, observer);
    } catch {
      // Never let the error handler itself escape into the flow.
    }
    return;
  }

  if (warnedObservers.has(observer)) return;
  warnedObservers.add(observer);

  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[warlock-ai] an observer's collect() threw and was isolated: ${message}`);
}
