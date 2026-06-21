import type { OrchestratorEvent } from "../contracts/orchestrator/orchestrator-event.type";
import type { StreamContract } from "../contracts/stream/stream.contract";

/**
 * Internal async-queue controller driving `orchestrator.stream()`.
 * Mirrors {@link import("../supervisor/supervisor-stream").createSupervisorStream}'s
 * controller — same producer/consumer pipe, parameterized by the
 * orchestrator event union and the terminal result type.
 *
 * The turn pushes events as it advances through the lifecycle phases,
 * then settles with `end(result)` (the same `OrchestratorResult` that
 * `execute()` resolves) or `fail(error)` on an authoring/drift throw.
 */
export type OrchestratorStreamController<TResult> = {
  push(event: OrchestratorEvent): void;
  end(result: TResult): void;
  fail(error: Error): void;
};

type PendingRead = {
  resolve(value: IteratorResult<OrchestratorEvent>): void;
  reject(error: Error): void;
};

/**
 * Factory mirroring `createSupervisorStream`. Returns a paired
 * `{ controller, stream }` — the turn pushes events into the controller
 * while the caller iterates (or awaits `.result`) on the stream side.
 *
 * The `result` promise resolves to the same `OrchestratorResult` value
 * `execute()` produces; it rejects only when the turn throws before
 * producing a result (drift / config misuse) — runtime failures ride on
 * `result.error` and still settle via `end()`.
 *
 * Child `supervisor.*` / `agent.*` events bubble through this same pipe
 * unmodified (the turn forwards them as it observes them on the
 * delegated run); they share the `{ type, ...payload }` shape with the
 * orchestrator's own events so iteration narrows uniformly on
 * `event.type`.
 */
export function createOrchestratorStream<TResult>(): {
  controller: OrchestratorStreamController<TResult>;
  stream: StreamContract<TResult, OrchestratorEvent>;
} {
  const queue: OrchestratorEvent[] = [];
  const pending: PendingRead[] = [];
  const handlers = new Map<string, (event: OrchestratorEvent) => void>();

  let closed = false;
  let failure: Error | undefined;
  let resolveResult!: (value: TResult) => void;
  let rejectResult!: (error: Error) => void;

  const result = new Promise<TResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const controller: OrchestratorStreamController<TResult> = {
    push(event) {
      const handler = handlers.get(event.type);

      if (handler) {
        try {
          handler(event);
        } catch {
          // Stream handlers must never crash the orchestrator.
        }
      }

      const reader = pending.shift();

      if (reader) {
        reader.resolve({ value: event, done: false });
        return;
      }

      queue.push(event);
    },

    end(finalResult) {
      closed = true;
      resolveResult(finalResult);

      while (pending.length > 0) {
        pending.shift()?.resolve({ value: undefined, done: true });
      }
    },

    fail(error) {
      closed = true;
      failure = error;
      rejectResult(error);

      while (pending.length > 0) {
        pending.shift()?.reject(error);
      }
    },
  };

  const iterator: AsyncIterator<OrchestratorEvent> = {
    next() {
      if (queue.length > 0) {
        return Promise.resolve({ value: queue.shift()!, done: false });
      }

      if (closed) {
        if (failure) {
          return Promise.reject(failure);
        }

        return Promise.resolve({ value: undefined, done: true });
      }

      return new Promise<IteratorResult<OrchestratorEvent>>(
        (resolve, reject) => {
          pending.push({ resolve, reject });
        },
      );
    },
  };

  const stream = {
    result,
    on(handlerMap) {
      for (const [key, handler] of Object.entries(handlerMap)) {
        if (handler) {
          handlers.set(key, handler as (event: OrchestratorEvent) => void);
        }
      }

      return stream;
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  } as StreamContract<TResult, OrchestratorEvent>;

  return { controller, stream };
}
