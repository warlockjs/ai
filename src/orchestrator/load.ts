import type { CheckpointRecord } from "../contracts/orchestrator/checkpoint-store.contract";
import type { OrchestratorEngineContext } from "./engine-context.type";

/**
 * Outcome of Phase 1 — load session (orchestrator.md §4 Phase 1).
 *
 * `record` is the latest persisted checkpoint, or `undefined` for a
 * brand-new session. `state` is the starting accumulator the turn
 * mutates: the rehydrated `state` on a subsequent call, or the
 * `config.state ?? {}` seed on first call (the framework never
 * re-seeds from `config.state` once a session exists — §4 Phase 1).
 * `turnIndex` is the index of the turn ABOUT to run (loaded + 1, or 0
 * on first call). `previousTurnIndex` is the loaded value (or -1 when
 * none) — needed by resume's `runId` derivation (§9.1).
 */
export type LoadedSession<TState> = {
  /** Latest persisted checkpoint, or `undefined` for a new session. */
  record: CheckpointRecord | undefined;
  /** Whether a prior checkpoint existed (drives `session.loaded.found`). */
  found: boolean;
  /** Starting state accumulator for this turn. */
  state: TState;
  /** Index of the turn about to run. */
  turnIndex: number;
  /** Index of the last settled turn (-1 when the session is new). */
  previousTurnIndex: number;
};

/**
 * Deep-clone a JSON-serializable value so a rehydrated checkpoint's
 * `state` can be mutated by the turn without aliasing the stored row
 * (the in-memory store hands back live references). Mirrors the
 * round-trip semantics the design mandates for state (§5 — "JSON-
 * serializable only", `JSON.parse(JSON.stringify(...))`-equivalent).
 */
function cloneState<TState>(state: unknown): TState {
  if (state === undefined || state === null) {
    return {} as TState;
  }

  return JSON.parse(JSON.stringify(state)) as TState;
}

/**
 * Phase 1 — load session. Reads the latest checkpoint for the session
 * and resolves the starting state accumulator + the turn index about
 * to run.
 *
 * First-call seeding (Q2): when no checkpoint exists this is the
 * session's birth — `state` defaults to `config.state ?? {}` and
 * `turnIndex` is 0. Subsequent calls rehydrate the persisted `state`
 * and advance the turn index. The dev-passed `options.history` is the
 * per-call seed (Path 2 — the framework never persists messages), so
 * load does not touch history.
 *
 * Does NOT apply the per-call `state` patch — that shallow-merges over
 * this result in the dispatch phase (§5), where the supervisor seed is
 * assembled.
 */
export async function loadSession<TState>(
  ctx: OrchestratorEngineContext<unknown, TState>,
  sessionId: string,
): Promise<LoadedSession<TState>> {
  const record = await ctx.checkpointStore.load(ctx.config.name, sessionId);

  if (!record) {
    return {
      record: undefined,
      found: false,
      state: cloneState<TState>(ctx.config.state),
      turnIndex: 0,
      previousTurnIndex: -1,
    };
  }

  return {
    record,
    found: true,
    state: cloneState<TState>(record.state),
    turnIndex: record.turn_index + 1,
    previousTurnIndex: record.turn_index,
  };
}
