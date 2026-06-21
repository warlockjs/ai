import type { CheckpointRecord } from "../contracts/orchestrator/checkpoint-store.contract";
import type { Next } from "../contracts/supervisor/next.type";
import type { OrchestratorEngineContext } from "./engine-context.type";

/** Framework default for snapshot retention per session (§4 Phase 6). */
export const DEFAULT_KEEP_SNAPSHOTS = 100;

/** Fields the engine supplies to build a fresh checkpoint row. */
export type PersistParams<TState> = {
  ctx: OrchestratorEngineContext<unknown, TState>;
  sessionId: string;
  turnIndex: number;
  state: unknown;
  /** Dispatch decision summary — a single intent, fan-out list, or null. */
  lastRoute: string | string[] | null;
  /** Carried forward from the loaded checkpoint (compaction progress). */
  summarizedThrough: number | null;
};

/**
 * Summarize a supervisor dispatch decision into the `last_route`
 * checkpoint column (§4 Phase 6). A bare string passes through; a
 * fan-out array passes through; the `END` sentinel and anything else
 * collapse to `null` (the turn routed nowhere worth recording).
 */
export function summarizeRoute(next: Next | undefined): string | string[] | null {
  if (typeof next === "string") {
    return next === "__warlock:end__" ? null : next;
  }

  if (Array.isArray(next)) {
    return next;
  }

  return null;
}

/**
 * Phase 6 — persist checkpoint (orchestrator.md §3 / §4 Phase 6).
 * Writes a fresh append-only row at `turn_index = N` carrying the
 * post-merge `state`, the current `signature` (read by the next call's
 * Phase 2), the informational `version`, the dispatch `last_route`, and
 * the carried-forward `summarized_through`. Lock columns are written
 * `null` here — they are populated only by an in-flight Phase 7
 * compaction.
 *
 * Emits `orchestrator.checkpoint.persisted` after the row lands, then
 * prunes to `keepSnapshots` (default 100; `"all"` opts out) — §4 Phase
 * 6 pruning (Q20). Pruning runs only when the store exposes the
 * optional `prune` hook (memory/pg/redis own their own pruning); when
 * absent the write still succeeds.
 *
 * Returns the persisted record so the engine can fold it into the
 * turn's report.
 */
export async function persistCheckpoint<TState>(
  params: PersistParams<TState>,
): Promise<CheckpointRecord> {
  const { ctx, sessionId, turnIndex, state, lastRoute, summarizedThrough } = params;

  const record: CheckpointRecord = {
    orchestrator_name: ctx.config.name,
    session_id: sessionId,
    turn_index: turnIndex,
    state,
    last_route: lastRoute,
    signature: ctx.signature,
    version: ctx.config.version ?? null,
    summarized_through: summarizedThrough,
    lock_acquired_at: null,
    lock_expires_at: null,
    saved_at: new Date().toISOString(),
  };

  await ctx.checkpointStore.save(record);

  ctx.emitter.emit("orchestrator.checkpoint.persisted", {
    sessionId,
    turnIndex,
  });

  await prune(ctx, sessionId, turnIndex);

  return record;
}

/**
 * Prune session rows older than `max_turn_index - keepSnapshots` (§4
 * Phase 6). Synchronous-after-save; opted out with
 * `keepSnapshots: "all"`. Delegated to an optional store-side `prune`
 * hook so each driver implements deletion in its own dialect — the
 * engine never reaches into store internals.
 */
async function prune<TState>(
  ctx: OrchestratorEngineContext<unknown, TState>,
  sessionId: string,
  latestTurnIndex: number,
): Promise<void> {
  const keep = ctx.config.keepSnapshots ?? DEFAULT_KEEP_SNAPSHOTS;

  if (keep === "all") {
    return;
  }

  const store = ctx.checkpointStore as {
    prune?: (
      orchestratorName: string,
      sessionId: string,
      keepBeforeTurnIndex: number,
    ) => Promise<void>;
  };

  if (typeof store.prune !== "function") {
    return;
  }

  const keepBeforeTurnIndex = latestTurnIndex - keep + 1;

  if (keepBeforeTurnIndex <= 0) {
    return;
  }

  await store.prune(ctx.config.name, sessionId, keepBeforeTurnIndex);
}
