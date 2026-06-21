/**
 * A single persisted orchestrator session checkpoint. One row is
 * written per settled turn — the primary key is
 * `(orchestrator_name, session_id, turn_index)`, append-only from v1
 * (orchestrator.md §8.2 / §8.6). The latest row (highest
 * `turn_index`) is the live session state.
 *
 * All fields are JSON-serializable. `state` is `unknown` because its
 * shape is the orchestrator's `TState`, validated upstream — the store
 * only round-trips it.
 *
 * Naming follows the on-disk DDL columns verbatim (snake_case) so the
 * record maps 1:1 onto the reference table in orchestrator.md §8.6 and
 * the pg driver can read/write it without a field-rename layer.
 */
export type CheckpointRecord = {
  /** Orchestrator definition name — first PK segment, partitions sessions across orchestrators. */
  orchestrator_name: string;
  /** Caller-owned session identifier — second PK segment. */
  session_id: string;
  /** Monotonic turn counter — third PK segment; the row with the highest value is live. */
  turn_index: number;
  /** Post-merge session accumulator. JSON-serializable; shape is the orchestrator's `TState`. */
  state: unknown;
  /** Summary of the turn's dispatch decision — a single intent, a fan-out list, or `null` on a turn that routed nowhere. */
  last_route: string | string[] | null;
  /** Structural fingerprint of the orchestrator definition at write time; compared on load for drift detection. */
  signature: string;
  /** Informational `config.version` tag, or `null` when unset. Metadata only — never drives behavior. */
  version: string | null;
  /** Exclusive turn index through which compaction has been applied, or `null` when no compaction has landed. */
  summarized_through: number | null;
  /** ISO timestamp when a compaction lock was taken, or `null` when no lock is held. */
  lock_acquired_at: string | null;
  /** ISO timestamp when the compaction lock expires, or `null` when no lock is held. */
  lock_expires_at: string | null;
  /** ISO timestamp written server-side when the row was persisted. */
  saved_at: string;
};

/**
 * Durable store for orchestrator session state (orchestrator.md §8.2).
 *
 * Owns the checkpoint rows that let `ai.orchestrator()` rehydrate a
 * session across calls: `state`, `turn_index`, drift `signature`,
 * `version`, `last_route`, compaction progress, and lock metadata.
 * Distinct from {@link import("./snapshot-store.contract").SnapshotStore},
 * which persists the per-turn internal supervisor run for
 * `iterate: true` mid-turn resume.
 *
 * Implementations: `ai.checkpoint.{memory,pg,redis}()`. The memory
 * impl ships in v1; pg/redis follow. Schema is never auto-migrated —
 * {@link CheckpointStore.schema} returns a DDL string the dev runs
 * through their own migration tool (§8.5).
 */
export interface CheckpointStore {
  /**
   * Load the latest checkpoint (highest `turn_index`) for a session,
   * or `undefined` for a brand-new session the store has never seen.
   */
  load(
    orchestratorName: string,
    sessionId: string,
  ): Promise<CheckpointRecord | undefined>;

  /**
   * Persist a fresh checkpoint row. Append-only — never overwrites a
   * prior `turn_index`. The key is derived from
   * `(orchestrator_name, session_id, turn_index)` on the record.
   */
  save(record: CheckpointRecord): Promise<void>;

  /**
   * Delete every checkpoint row for a session, ending it.
   */
  delete(orchestratorName: string, sessionId: string): Promise<void>;

  /**
   * List the session ids known for an orchestrator, optionally
   * filtered by a session-id prefix. Used by the production boot-drain
   * loop (§9.3). Optional — stores that can't enumerate omit it.
   */
  list?(orchestratorName: string, prefix?: string): Promise<string[]>;

  /**
   * Drop every row for a session whose `turn_index` is strictly below
   * `keepBeforeTurnIndex`, honoring `keepSnapshots` retention (§4 Phase
   * 6, Q20). Called after each settled turn's save. Optional — stores
   * that prune in their own dialect (or never prune) omit it; the engine
   * skips pruning when it is absent.
   */
  prune?(
    orchestratorName: string,
    sessionId: string,
    keepBeforeTurnIndex: number,
  ): Promise<void>;

  /**
   * Return the DDL string for this store's backing table. The dev runs
   * it through their migration tool; the framework never auto-migrates
   * (§8.5).
   */
  schema(): string;

  /**
   * Optional idle-TTL knob. Stores that support row expiry honor it;
   * others may no-op.
   */
  setOptions?(options: { ttl?: number }): void;
}
