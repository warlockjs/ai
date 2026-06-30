import type { Observer } from "./observer.contract";

/**
 * Module-level list of globally registered {@link Observer}s. A flow
 * that resolves to "observed" hands its finished report to every entry
 * here. An observability tool (panoptic, …) registers exactly one
 * collector when its config is applied.
 */
const observers: Observer[] = [];

/**
 * Global "observe every flow by default" flag. When `true`, a flow that
 * did not set its own `observe` option is observed (routed to the
 * globally registered observers). Individual flows opt out with
 * `observe: false`. Default `false` — opt-in observability.
 */
let observeAll = false;

/**
 * Register a global {@link Observer}. Every flow that resolves to
 * "observed" (via `observeAll` or `observe: true`) routes its completed
 * report to it. An observability tool registers its collector here once,
 * when its config is applied.
 */
export function registerObserver(observer: Observer): void {
  observers.push(observer);
}

/**
 * The currently registered global observers. Returned as a read-only
 * snapshot reference — callers must not mutate it; use
 * {@link registerObserver} to add and {@link clearObservers} (test-only)
 * to reset.
 */
export function getObservers(): readonly Observer[] {
  return observers;
}

/**
 * Set the global "observe every flow by default" flag. An observability
 * tool flips this on when configured with its own observe-all option.
 */
export function setObserveAll(value: boolean): void {
  observeAll = value;
}

/**
 * Read the global "observe every flow by default" flag. Consulted by the
 * observe-resolution helper when a flow left `observe` undefined.
 */
export function isObserveAll(): boolean {
  return observeAll;
}

/**
 * Reset the registry to its initial empty state — clears all registered
 * observers and turns off the observe-all flag. Internal: intended for
 * test isolation so one spec's registrations don't leak into the next.
 * Not part of the public surface.
 */
export function clearObservers(): void {
  observers.length = 0;
  observeAll = false;
}
