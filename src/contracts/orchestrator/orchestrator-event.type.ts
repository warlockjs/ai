import type { EventIdentity } from "../events/event-identity.type";
import type { CompactionResult } from "../result/orchestrator-result.type";

/**
 * Per-turn lifecycle event payloads emitted under the `orchestrator.*`
 * namespace (design §14). Three-tier subscription — definition,
 * instance, per-call — fires in that order on every emission, mirroring
 * the supervisor + workflow model.
 *
 * Child events (`supervisor.*` / `agent.*`) bubble up UNMODIFIED under
 * their own identity (§14.2) and are intentionally NOT folded into this
 * map — subscribers filter the bubbled stream by namespace. This map
 * carries only the orchestrator's own session-scoped events.
 *
 * Until the shared `contracts/events` taxonomy grows an
 * `orchestrator.*` slice, this local map is the source of truth for the
 * orchestrator `on`/`off`/`stream` surface; it is structured to be
 * promoted into `contracts/events/event-map.type.ts` later without a
 * shape change (Q14 event taxonomy is a v1 design item; see §14).
 */
export type OrchestratorEventMap = {
  /** Turn N begins (before phase 1). */
  "orchestrator.turn.starting": { sessionId: string; turnIndex: number };
  /** Phase 1 — checkpoint loaded (or seeded empty on first call). */
  "orchestrator.session.loaded": {
    sessionId: string;
    turnIndex: number;
    found: boolean;
  };
  /** Phase 2 — drift signature compared against the loaded checkpoint. */
  "orchestrator.drift.checked": {
    sessionId: string;
    signature: string;
    drifted: boolean;
  };
  /** Phase 3 — waiting on the compaction lock (only when locked). */
  "orchestrator.lock.waiting": { sessionId: string; waitedMs: number };
  /** Phase 4 — history windowed for router + agents. */
  "orchestrator.history.windowed": { sessionId: string; messageCount: number };
  /** Phase 5 — route/router produced a dispatch decision. */
  "orchestrator.turn.routed": {
    sessionId: string;
    turnIndex: number;
    source: "route" | "router" | "intent.next";
    raw: unknown;
  };
  /** Per-token streaming during the dispatched primitive's run. */
  "orchestrator.turn.streaming": { sessionId: string; delta: string };
  /** Phase 6 — checkpoint row written for the settled turn. */
  "orchestrator.checkpoint.persisted": {
    sessionId: string;
    turnIndex: number;
  };
  /** Phase 7 — compaction trigger fired (only when triggered). */
  "orchestrator.compaction.suggested": {
    sessionId: string;
    compaction: CompactionResult;
  };
  /** Phase 7 — `onCompact` ran successfully and the summary applied. */
  "orchestrator.compaction.applied": {
    sessionId: string;
    compaction: CompactionResult;
  };
  /**
   * Phase 7 — the summarizer or `onCompact` threw; compaction was skipped
   * for this turn and the session keeps running with unchanged history
   * (§4 Phase 7 skip-and-log). `phase` distinguishes which step failed.
   */
  "orchestrator.compaction.failed": {
    sessionId: string;
    phase: "summarize" | "onCompact";
    error: unknown;
  };
  /** Terminal — turn ran to a usable result. */
  "orchestrator.turn.completed": { sessionId: string; turnIndex: number };
  /** Terminal — turn failed; the typed cause rides on the result. */
  "orchestrator.turn.failed": { sessionId: string; turnIndex: number };
  /** Terminal — caller aborted the turn via `AbortSignal`. */
  "orchestrator.turn.cancelled": { sessionId: string; turnIndex: number };
  /** Non-terminal — session paused waiting for the next user turn (§15.6). */
  "orchestrator.turn.awaiting-input": {
    sessionId: string;
    turnIndex: number;
  };
};

/**
 * Discriminated union of every orchestrator event, each tagged with a
 * `type` literal and carrying its payload plus run `EventIdentity`.
 * This is the `TEvent` parameter for `orchestrator.stream()`.
 */
export type OrchestratorEvent = {
  [K in keyof OrchestratorEventMap]: {
    type: K;
  } & OrchestratorEventMap[K] &
    EventIdentity;
}[keyof OrchestratorEventMap];

/** Every legal orchestrator event name. */
export type OrchestratorEventName = keyof OrchestratorEventMap;

/**
 * Handler for a single orchestrator event. Receives the event's typed
 * payload (identity-injected centrally by the orchestrator's `emit`);
 * return value is ignored.
 */
export type OrchestratorEventHandler<K extends OrchestratorEventName> = (
  payload: OrchestratorEventMap[K] & EventIdentity,
) => void;

/**
 * Definition / instance / per-call handler bag — tier surface accepted
 * by `OrchestratorConfig.on` and the per-call `options.on`. Mirrors
 * `SupervisorEventHandlers`.
 */
export type OrchestratorEventHandlers = Partial<{
  [K in OrchestratorEventName]: OrchestratorEventHandler<K>;
}>;
