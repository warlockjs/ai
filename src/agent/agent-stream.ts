import type { StreamContract, StreamEvent } from "../contracts";

/**
 * Internal async-queue `StreamContract` used by `agent().stream()`.
 *
 * **Role.** The bridge between a streaming `Execution` (which runs in the
 * background, pushing events as they happen) and a consumer that reads
 * those events with `for await` or an `on(...)` handler map.
 *
 * **Responsibility.**
 * - Owns: the event queue, the pending-read promise chain, the terminal
 *   `result` promise, and any user-registered event handlers.
 * - Does NOT own: any knowledge of agents, models, or tool calls — it is a
 *   generic producer/consumer pipe parameterized by `TResult`. The streaming
 *   execution writes via `push()` / `end()` / `fail()`; the consumer reads
 *   via the AsyncIterable surface.
 *
 * Events are coalesced into a queue so that a consumer that starts
 * iterating late still sees every event in order — nothing is dropped. The
 * `on()` handlers fire the moment an event is pushed, independent of
 * whether anyone is iterating.
 *
 * @example
 * // Inside agent.stream():
 * const { controller, stream } = createAgentStream<AgentResult<TOutput>>();
 * new Execution(config, input, options, controller).run();
 * return stream;
 *
 * // Consumer:
 * for await (const event of stream) {
 *   if (event.type === "streaming") process.stdout.write(event.delta);
 * }
 * const result = await stream.result;
 */
export type StreamController<TResult> = {
  push(event: StreamEvent): void;
  end(result: TResult): void;
  fail(error: Error): void;
};

type PendingRead = {
  resolve(value: IteratorResult<StreamEvent>): void;
  reject(error: Error): void;
};

export function createAgentStream<TResult>(): {
  controller: StreamController<TResult>;
  stream: StreamContract<TResult>;
} {
  const queue: StreamEvent[] = [];
  const pending: PendingRead[] = [];
  const handlers = new Map<StreamEvent["type"], (event: StreamEvent) => void>();

  let closed = false;
  let failure: Error | undefined;
  let resolveResult!: (value: TResult) => void;
  let rejectResult!: (error: Error) => void;

  const result = new Promise<TResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const controller: StreamController<TResult> = {
    push(event) {
      const handler = handlers.get(event.type);

      if (handler) {
        try {
          handler(event);
        } catch {
          // User-provided stream handlers must never crash the agent.
          // Swallow — structured logging attaches here in Phase 0.5.
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
        const reader = pending.shift();

        reader?.resolve({ value: undefined, done: true });
      }
    },

    fail(error) {
      closed = true;
      failure = error;
      rejectResult(error);

      while (pending.length > 0) {
        const reader = pending.shift();

        reader?.reject(error);
      }
    },
  };

  const iterator: AsyncIterator<StreamEvent> = {
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

      return new Promise<IteratorResult<StreamEvent>>((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    },
  };

  const stream: StreamContract<TResult> = {
    result,
    on(handlerMap) {
      for (const [key, handler] of Object.entries(handlerMap)) {
        if (handler) {
          handlers.set(
            key as StreamEvent["type"],
            handler as (event: StreamEvent) => void,
          );
        }
      }

      return stream;
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };

  return { controller, stream };
}
