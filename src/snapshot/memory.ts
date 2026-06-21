import type { SnapshotStore } from "../contracts/orchestrator/snapshot-store.contract";
import type { SupervisorSnapshot } from "../contracts/supervisor/supervisor-snapshot.type";

/**
 * In-memory {@link SnapshotStore} — supervisor run snapshots held in a
 * process-local `Map`, keyed by `runId`, never persisted to disk.
 *
 * Owns: the `runId` → {@link SupervisorSnapshot} mapping for
 * `iterate: true` mid-turn resume. Does NOT own: durability,
 * cross-process sharing, or TTL eviction — it is the zero-config
 * default for dev, tests, and single-process apps. Reach for
 * `ai.snapshot.pg()` / `ai.snapshot.redis()` (Phase 2) when a crashed
 * process must resume an in-flight turn.
 *
 * Front it with the {@link memory} factory — callers never `new` it.
 */
class MemorySnapshotStore<TSnapshot extends { runId: string }>
  implements SnapshotStore<TSnapshot>
{
  /** Snapshots keyed by `runId`. */
  private readonly snapshots = new Map<string, TSnapshot>();

  /**
   * Return the snapshot for a `runId`, or `undefined` when no in-flight
   * run is recorded.
   */
  public async load(runId: string): Promise<TSnapshot | undefined> {
    return this.snapshots.get(runId);
  }

  /**
   * Persist a snapshot, keyed by its own `runId`. Overwrites any prior
   * snapshot for the same run — a run has exactly one live snapshot.
   */
  public async save(snapshot: TSnapshot): Promise<void> {
    this.snapshots.set(snapshot.runId, snapshot);
  }

  /**
   * Drop the snapshot for a `runId`.
   */
  public async delete(runId: string): Promise<void> {
    this.snapshots.delete(runId);
  }

  /**
   * List the known run ids, optionally filtered by a prefix.
   */
  public async list(prefix?: string): Promise<string[]> {
    const runIds: string[] = [];

    for (const runId of this.snapshots.keys()) {
      if (prefix !== undefined && !runId.startsWith(prefix)) {
        continue;
      }

      runIds.push(runId);
    }

    return runIds;
  }

  /**
   * The memory store has no backing table — there is nothing to
   * migrate. Returns an empty string so callers can treat `schema()`
   * uniformly across drivers.
   */
  public schema(): string {
    return "";
  }
}

/**
 * Create an in-memory {@link SnapshotStore}. Zero-config — no client,
 * no connection. Suitable for dev, tests, and single-process apps that
 * don't need to resume an interrupted `iterate: true` turn across
 * restarts.
 *
 * @example
 * import { ai } from "@warlock.js/ai";
 *
 * const orchestrator = ai.orchestrator({
 *   name: "support",
 *   intents: { ... },
 *   iterate: true,
 *   snapshotStore: ai.snapshot.memory(),
 * });
 */
export function memory<
  TSnapshot extends { runId: string } = SupervisorSnapshot,
>(): SnapshotStore<TSnapshot> {
  return new MemorySnapshotStore<TSnapshot>();
}
