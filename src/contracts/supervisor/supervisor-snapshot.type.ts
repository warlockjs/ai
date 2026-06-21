import type { IterationSnapshot } from "./iteration-snapshot.type";

/**
 * Lifecycle status of a supervisor run, recorded on the persisted
 * snapshot so resume can decide whether a run is still in flight.
 *
 * - `"running"` — the iteration loop is active; a resume is
 *   legitimate if the process crashed.
 * - `"completed"` — the supervisor terminated successfully; resume
 *   is a no-op and returns the final state.
 * - `"cancelled"` — aborted via `AbortSignal`; resume is allowed
 *   (the caller decides whether to retry).
 * - `"failed"` — terminated with an error; resume after the fix.
 */
export type SupervisorSnapshotStatus =
  | "running"
  | "completed"
  | "cancelled"
  | "failed";

/**
 * Persisted shape written to the configured `KVStore` after every
 * iteration settles. Exists so `supervisor.resume(runId)` can
 * re-hydrate the history + iteration counter and continue from the
 * next turn.
 *
 * `signature` is a structural fingerprint covering the agent keys,
 * their resolved descriptions, the router's identity (if any), and
 * whether `route` was configured. `resume()` compares this against
 * the current supervisor's signature; mismatch throws
 * `SupervisorDriftError` (bypassable with `{ force: true }`).
 *
 * @example
 * const snapshot: SupervisorSnapshot = await store.get(`supervisor:${runId}`);
 * if (snapshot?.status === "running") {
 *   await supervisor.resume(runId);
 * }
 */
export type SupervisorSnapshot = {
  runId: string;
  supervisorName: string;
  signature: string;
  /** The original `execute(input)` value — needed on resume. */
  input: import("./supervisor-input.type").SupervisorInput;
  /** Index of the last *completed* iteration; -1 before any settle. */
  iteration: number;
  snapshots: IterationSnapshot[];
  status: SupervisorSnapshotStatus;
  startedAt: string;
  savedAt: string;
};
