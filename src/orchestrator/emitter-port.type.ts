import type {
  OrchestratorEventHandlers,
  OrchestratorEventMap,
} from "../contracts/orchestrator/orchestrator-event.type";

/**
 * Minimal structural surface the C2 engine needs from the orchestrator
 * emitter (owned by C1's `emitter.ts`). Declared as a port so the
 * engine depends only on the shape it calls, never on C1's concrete
 * emitter class — keeping the two components decoupled.
 *
 * The engine emits one event per lifecycle phase (orchestrator.md
 * §14.1) and registers the per-call `options.on` handlers (tier 3) for
 * the duration of a single turn. `emit` injects run `EventIdentity`
 * centrally inside the emitter, so the engine passes only the typed
 * payload.
 */
export type OrchestratorEmitterLike = {
  /**
   * Fire an event to all three tiers (definition → instance →
   * per-call) in order. Identity is injected by the emitter.
   */
  emit<K extends keyof OrchestratorEventMap>(
    event: K,
    payload: OrchestratorEventMap[K],
  ): void;

  /**
   * Register the per-call handler bag (tier 3) for the scope of one
   * turn. Returns a disposer the engine calls in a `finally` to unwind
   * the per-call subscriptions when the turn settles.
   */
  bindPerCall(handlers: OrchestratorEventHandlers | undefined): () => void;
};
