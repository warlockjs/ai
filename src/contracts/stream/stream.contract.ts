import type { StreamEvent } from "./stream-event.type";

/**
 * An async iterable stream that also exposes a result promise.
 * Returned by every primitive's `stream()` method.
 *
 * Parameterized by **`TResult`** (the value `result` resolves to —
 * `AgentResult`, `WorkflowResult`, `SupervisorResult`, etc.) and
 * **`TEvent`** (the discriminated union iterated over). `TEvent`
 * defaults to the agent's `StreamEvent` so existing agent consumers
 * keep working unchanged; primitives whose event surface differs
 * (e.g. `SupervisorStreamEvent` in `supervisor.stream()`) parameterize
 * the second slot to surface their own events to consumers.
 *
 * @example
 * // Agent stream — TEvent defaults to StreamEvent
 * const stream = agent.stream("Explain quantum computing");
 * for await (const event of stream) {
 *   if (event.type === "agent.trip.streaming") process.stdout.write(event.delta);
 * }
 *
 * @example
 * // Supervisor stream — TEvent narrowed to SupervisorStreamEvent
 * const stream = supportBot.stream(message);
 * for await (const event of stream) {
 *   if (event.type === "supervisor.agent.streaming") process.stdout.write(event.delta);
 * }
 *
 * @example
 * // Or await just the final result
 * const result = await stream.result;
 * console.log(result.usage.total, "tokens used");
 *
 * @example
 * // Attach named handlers instead of iterating
 * const stream = agent.stream("Write a poem");
 * stream
 *   .on({ "agent.trip.streaming": ({ delta }) => process.stdout.write(delta) })
 *   .on({ "agent.completed": () => console.log("Done!") });
 * const result = await stream.result;
 */
export interface StreamContract<
  TResult,
  TEvent extends { type: string } = StreamEvent,
> extends AsyncIterable<TEvent> {
  /**
   * Promise that resolves to the full execution result once streaming completes.
   * Rejects if the execution fails.
   */
  result: Promise<TResult>;

  /**
   * Attach event handlers by event type. Returns `this` for chaining.
   * Handlers registered here fire in addition to iteration.
   */
  on(
    handlers: Partial<{
      [K in TEvent["type"]]: (event: Extract<TEvent, { type: K }>) => void;
    }>,
  ): this;
}
