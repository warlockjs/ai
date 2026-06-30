import { encodeSSE, SSE_DONE } from "./sse";

/**
 * A streamable execution: an async iterable of typed events that also
 * exposes the final `result` promise — exactly the shape every primitive's
 * `stream()` returns ({@link StreamContract}).
 */
export type StreamLike<TEvent extends { type: string }, TResult> =
  AsyncIterable<TEvent> & { result?: Promise<TResult> };

/**
 * Convert a primitive's event stream into an SSE byte stream (A3): each
 * event becomes an SSE frame named by its `type`, then the final `result`
 * (or an `error` frame if it rejects) is emitted, and finally the
 * `[DONE]` sentinel. Pure and transport-agnostic — {@link serve} pipes it
 * to an HTTP response, but it works against any sink.
 *
 * @example
 * for await (const frame of streamToSSE(agent.stream("hi"))) {
 *   res.write(frame);
 * }
 */
export async function* streamToSSE<TEvent extends { type: string }, TResult>(
  stream: StreamLike<TEvent, TResult>,
): AsyncIterable<string> {
  for await (const event of stream) {
    yield encodeSSE({ event: event.type, data: event });
  }

  if (stream.result) {
    try {
      const result = await stream.result;
      yield encodeSSE({ event: "result", data: result });
    } catch (error) {
      yield encodeSSE({
        event: "error",
        data: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  yield SSE_DONE;
}
