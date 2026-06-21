import type { WithoutIdentity } from "../contracts/events/event-identity.type";
import type { WorkflowEventMap } from "../contracts/events/event-map.type";
import type {
  WorkflowEventHandler,
  WorkflowEventHandlers,
} from "../contracts/workflow/workflow.contract";

type AnyHandler = WorkflowEventHandler<keyof WorkflowEventMap>;

/**
 * The emit surface the workflow engine and step-runner depend on.
 * They never construct run identity themselves — they hand a bare
 * payload to a sink that injects `runId` / `rootRunId` before
 * delegating to the real three-tier `WorkflowEmitter`.
 *
 * `WorkflowEmitter` is factory-scoped (shared across every
 * `execute()`), so it cannot own per-run identity. A per-run sink
 * (see `runScopedEmitter`) closes that gap without touching the ~15
 * `emit` call sites in `engine.ts` / `step-runner.ts`.
 */
export interface WorkflowEventSink {
  emit<K extends keyof WorkflowEventMap>(
    event: K,
    payload: WithoutIdentity<WorkflowEventMap[K]>,
    executionHandlers?: WorkflowEventHandlers,
  ): void;
}

/**
 * Three-tier workflow event emitter — factory (definition) → instance →
 * per-execution. All matching handlers fire, in layer order. Handler
 * errors are swallowed so listener bugs can never derail the workflow.
 */
export class WorkflowEmitter {
  private readonly factoryHandlers?: WorkflowEventHandlers;
  private readonly instanceHandlers = new Map<
    keyof WorkflowEventMap,
    Set<AnyHandler>
  >();

  public constructor(factoryHandlers?: WorkflowEventHandlers) {
    this.factoryHandlers = factoryHandlers;
  }

  public on<K extends keyof WorkflowEventMap>(
    event: K,
    handler: WorkflowEventHandler<K>,
  ): () => void {
    let bucket = this.instanceHandlers.get(event);
    if (!bucket) {
      bucket = new Set();
      this.instanceHandlers.set(event, bucket);
    }
    bucket.add(handler as AnyHandler);
    return () => this.off(event, handler);
  }

  public off<K extends keyof WorkflowEventMap>(
    event: K,
    handler: WorkflowEventHandler<K>,
  ): void {
    this.instanceHandlers.get(event)?.delete(handler as AnyHandler);
  }

  public emit<K extends keyof WorkflowEventMap>(
    event: K,
    payload: WorkflowEventMap[K],
    executionHandlers?: WorkflowEventHandlers,
  ): void {
    // Layer 1 — factory
    invoke(this.factoryHandlers?.[event], payload);

    // Layer 2 — instance (set-based, possibly many handlers)
    const bucket = this.instanceHandlers.get(event);
    if (bucket) {
      for (const handler of bucket) invoke(handler, payload);
    }

    // Layer 3 — per-execution
    invoke(executionHandlers?.[event], payload);
  }
}

function invoke<K extends keyof WorkflowEventMap>(
  handler: ((payload: WorkflowEventMap[K]) => void) | undefined,
  payload: WorkflowEventMap[K],
): void {
  if (typeof handler !== "function") return;
  try {
    handler(payload);
  } catch {
    // Swallow — listener bugs must not derail workflow execution.
  }
}
