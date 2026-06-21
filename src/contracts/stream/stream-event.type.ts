import type { AIError } from "../../errors/ai-error";
import type { ToolEventMeta } from "../events/agent-events.type";
import type { EventIdentity } from "../events/event-identity.type";
import type { LLMTrip } from "../result/llm-trip.type";
import type { ToolCall } from "../result/tool-call.type";

/**
 * Discriminated union of all events emitted during a streaming execution.
 * Iterate over a StreamContract to receive these events.
 *
 * Event `type` strings use the same dot-notation as `AgentEventMap` keys
 * so filtering logic in subscribers reads the same whether they came
 * through `.on(...)` or the async iterator.
 *
 * Every variant also carries `EventIdentity` (`runId` / `rootRunId`)
 * via the `StreamEvent` intersection, so stream consumers can
 * correlate to a run the same way `.on(...)` subscribers do.
 *
 * @example
 * for await (const event of stream) {
 *   if (event.type === "agent.trip.streaming") process.stdout.write(event.delta);
 *   else if (event.type === "agent.tool.called") console.log("Tool:", event.toolCall.name);
 *   else if (event.type === "agent.trip.completed") console.log("Trip done");
 * }
 */
export type StreamEventBody =
  | { type: "agent.starting"; input: string }
  | { type: "agent.trip.started"; tripIndex: number; input: string }
  | { type: "agent.trip.streaming"; delta: string; tripIndex: number }
  | {
      type: "agent.tool.calling";
      tool: ToolEventMeta;
      input: unknown;
      tripIndex: number;
    }
  | { type: "agent.tool.called"; toolCall: ToolCall; tool: ToolEventMeta }
  | {
      type: "agent.tool.failed";
      tool: ToolEventMeta;
      error: AIError;
      tripIndex: number;
    }
  | { type: "agent.trip.completed"; trip: LLMTrip }
  | { type: "agent.completed" }
  | { type: "agent.error"; error: AIError };

/**
 * A `StreamEventBody` variant enriched with run identity. This is what
 * `agent.stream()` consumers actually receive on each iteration.
 */
export type StreamEvent = EventIdentity & StreamEventBody;
