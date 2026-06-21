import type { StreamContract } from "../contracts/stream/stream.contract";
import type { SupervisorStreamEvent } from "../contracts/supervisor/supervisor-stream-event.type";

// Re-export so internal callers that already imported from this file
// keep working unchanged. Canonical home is the contracts barrel.
export type { SupervisorStreamEvent };

/**
 * Internal async-queue controller driving `supervisor.stream()`.
 * Mirrors `StreamController` from `agent-stream.ts` — same
 * producer/consumer pipe, same semantics, parameterized by the
 * supervisor event union and terminal result type.
 */
export type SupervisorStreamController<TResult> = {
  push(event: SupervisorStreamEvent): void;
  end(result: TResult): void;
  fail(error: Error): void;
};

type PendingRead = {
  resolve(value: IteratorResult<SupervisorStreamEvent>): void;
  reject(error: Error): void;
};

/**
 * Factory mirroring `createAgentStream`. Returns a paired
 * `{ controller, stream }` — the `SupervisorExecution` pushes events
 * into the controller while the caller iterates (or awaits `.result`)
 * on the stream side. See `agent-stream.ts` for the full role
 * description.
 */
export function createSupervisorStream<TResult>(): {
  controller: SupervisorStreamController<TResult>;
  stream: StreamContract<TResult, SupervisorStreamEvent>;
} {
  const queue: SupervisorStreamEvent[] = [];
  const pending: PendingRead[] = [];
  const handlers = new Map<string, (event: SupervisorStreamEvent) => void>();

  let closed = false;
  let failure: Error | undefined;
  let resolveResult!: (value: TResult) => void;
  let rejectResult!: (error: Error) => void;

  const result = new Promise<TResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const controller: SupervisorStreamController<TResult> = {
    push(event) {
      const handler = handlers.get(event.type);

      if (handler) {
        try {
          handler(event);
        } catch {
          // Stream handlers must never crash the supervisor.
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

  const iterator: AsyncIterator<SupervisorStreamEvent> = {
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

      return new Promise<IteratorResult<SupervisorStreamEvent>>(
        (resolve, reject) => {
          pending.push({ resolve, reject });
        },
      );
    },
  };

  // The `StreamContract<TResult>` shape is shared across primitives —
  // it types `on()` over the generic `StreamEvent` union (agent
  // events). Supervisor events are a distinct discriminated union
  // with the same `type`-keyed shape, so we satisfy the contract via
  // a structural cast — handlers see the supervisor events at their
  // correct narrowed types.
  const stream = {
    result,
    on(handlerMap) {
      for (const [key, handler] of Object.entries(handlerMap)) {
        if (handler) {
          handlers.set(key, handler as (event: SupervisorStreamEvent) => void);
        }
      }

      return stream;
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  } as StreamContract<TResult, SupervisorStreamEvent>;

  return { controller, stream };
}
