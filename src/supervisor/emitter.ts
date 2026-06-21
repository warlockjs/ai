import type { SupervisorEventMap } from "../contracts/events/event-map.type";
import type {
  SupervisorEventHandler,
  SupervisorEventHandlers,
} from "../contracts/supervisor/supervisor-config.type";

type AnyHandler = SupervisorEventHandler<keyof SupervisorEventMap>;

/**
 * Three-tier supervisor event emitter — factory (definition) → instance
 * → per-execution. Mirrors `WorkflowEmitter` structurally; the only
 * difference is the event map. All matching handlers fire in layer
 * order. Handler errors are swallowed so a listener bug can never
 * derail the run.
 *
 * @example
 * const emitter = new SupervisorEmitter(definition.on);
 * const unsubscribe = emitter.on("supervisor.completed", (payload) => ...);
 * emitter.emit("supervisor.starting", { runId, rootRunId, supervisorName, input }, perCallHandlers);
 */
export class SupervisorEmitter {
  private readonly factoryHandlers?: SupervisorEventHandlers;
  private readonly instanceHandlers = new Map<
    keyof SupervisorEventMap,
    Set<AnyHandler>
  >();

  public constructor(factoryHandlers?: SupervisorEventHandlers) {
    this.factoryHandlers = factoryHandlers;
  }

  public on<K extends keyof SupervisorEventMap>(
    event: K,
    handler: SupervisorEventHandler<K>,
  ): () => void {
    let bucket = this.instanceHandlers.get(event);

    if (!bucket) {
      bucket = new Set();
      this.instanceHandlers.set(event, bucket);
    }

    bucket.add(handler as AnyHandler);

    return () => this.off(event, handler);
  }

  public off<K extends keyof SupervisorEventMap>(
    event: K,
    handler: SupervisorEventHandler<K>,
  ): void {
    this.instanceHandlers.get(event)?.delete(handler as AnyHandler);
  }

  public emit<K extends keyof SupervisorEventMap>(
    event: K,
    payload: SupervisorEventMap[K],
    executionHandlers?: SupervisorEventHandlers,
  ): void {
    invoke(this.factoryHandlers?.[event], payload);

    const bucket = this.instanceHandlers.get(event);

    if (bucket) {
      for (const handler of bucket) {
        invoke(handler, payload);
      }
    }

    invoke(executionHandlers?.[event], payload);
  }
}

function invoke<K extends keyof SupervisorEventMap>(
  handler: ((payload: SupervisorEventMap[K]) => void) | undefined,
  payload: SupervisorEventMap[K],
): void {
  if (typeof handler !== "function") {
    return;
  }

  try {
    handler(payload);
  } catch {
    // Listener bugs must not derail the supervisor.
  }
}
