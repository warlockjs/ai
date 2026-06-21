import type {
  EventIdentity,
  WithoutIdentity,
} from "../contracts/events/event-identity.type";
import type {
  OrchestratorEventHandler,
  OrchestratorEventHandlers,
  OrchestratorEventMap,
  OrchestratorEventName,
} from "../contracts/orchestrator/orchestrator-event.type";

/** Full identity-stamped payload an orchestrator handler receives. */
type EventPayload<K extends OrchestratorEventName> = OrchestratorEventMap[K] &
  EventIdentity;

/**
 * Erased handler shape for the instance registry. Per-event handlers
 * are contravariant in their payload, so the registry stores them under
 * a single structural `(payload) => void` and re-narrows at the call
 * site — the `on` / `off` public surface keeps the precise per-event
 * typing.
 */
type AnyHandler = (payload: EventPayload<OrchestratorEventName>) => void;

/**
 * Three-tier orchestrator event emitter — definition (factory) →
 * instance → per-call — for the `orchestrator.*` namespace (design
 * §14.3). Mirrors {@link import("../supervisor/emitter").SupervisorEmitter}
 * structurally; the differences are the event map and a central
 * identity-injection chokepoint (`emit` accepts an identity-less
 * payload and stamps {@link EventIdentity} once so all three tiers, and
 * any mirror like the stream, see the same value).
 *
 * Owns: the instance-handler registry and the fan-out order. Does NOT
 * own: child `supervisor.*` / `agent.*` events — those bubble up
 * unmodified under their own identity (§14.2) and never pass through
 * this emitter. All matching handlers fire in tier order; a handler
 * throwing never derails the turn.
 *
 * @example
 * const emitter = new OrchestratorEmitter(config.on);
 * const off = emitter.on("orchestrator.turn.completed", (event) => log(event));
 * emitter.emit(
 *   "orchestrator.turn.starting",
 *   { sessionId, turnIndex },
 *   { runId, rootRunId },
 *   perCallHandlers,
 * );
 */
export class OrchestratorEmitter {
  private readonly factoryHandlers?: OrchestratorEventHandlers;
  private readonly instanceHandlers = new Map<
    OrchestratorEventName,
    Set<AnyHandler>
  >();

  public constructor(factoryHandlers?: OrchestratorEventHandlers) {
    this.factoryHandlers = factoryHandlers;
  }

  /**
   * Subscribe an instance-level handler (tier 2). Returns an
   * unsubscribe function equivalent to `off(event, handler)`.
   */
  public on<K extends OrchestratorEventName>(
    event: K,
    handler: OrchestratorEventHandler<K>,
  ): () => void {
    let bucket = this.instanceHandlers.get(event);

    if (!bucket) {
      bucket = new Set();
      this.instanceHandlers.set(event, bucket);
    }

    bucket.add(handler as unknown as AnyHandler);

    return () => this.off(event, handler);
  }

  /**
   * Remove a previously-subscribed instance handler. No-op when the
   * handler was never registered or already removed.
   */
  public off<K extends OrchestratorEventName>(
    event: K,
    handler: OrchestratorEventHandler<K>,
  ): void {
    this.instanceHandlers.get(event)?.delete(handler as unknown as AnyHandler);
  }

  /**
   * Stamp run identity onto the payload, then fan out through all three
   * tiers in order: definition → instance → per-call. Returns the full
   * identity-stamped payload so the caller can mirror the same value
   * into the stream controller (keeping `.on()` and iteration in lockstep).
   */
  public emit<K extends OrchestratorEventName>(
    event: K,
    payload: WithoutIdentity<OrchestratorEventMap[K]>,
    identity: EventIdentity,
    perCallHandlers?: OrchestratorEventHandlers,
  ): EventPayload<K> {
    const fullPayload = { ...payload, ...identity } as EventPayload<K>;

    invoke(this.factoryHandlers?.[event], fullPayload);

    const bucket = this.instanceHandlers.get(event);

    if (bucket) {
      for (const handler of bucket) {
        invoke(handler as unknown as (payload: EventPayload<K>) => void, fullPayload);
      }
    }

    invoke(perCallHandlers?.[event], fullPayload);

    return fullPayload;
  }
}

/**
 * Invoke a single handler, swallowing any throw. A listener bug must
 * never derail the orchestrator turn. Typed structurally (a plain
 * `(payload) => void`) so the identity-stamped payload flows in without
 * fighting the contravariant `OrchestratorEventHandler<K>` union.
 */
function invoke<K extends OrchestratorEventName>(
  handler: ((payload: EventPayload<K>) => void) | undefined,
  payload: EventPayload<K>,
): void {
  if (typeof handler !== "function") {
    return;
  }

  try {
    handler(payload);
  } catch {
    // Listener bugs must not derail the orchestrator.
  }
}
