import type { AgentEventMap } from "../contracts/events/event-map.type";
import type { StreamEventBody } from "../contracts/stream/stream-event.type";

/**
 * Map an internal `AgentEventMap` entry into the public `StreamEvent`
 * shape. Event names are the same dot-notation strings on both sides;
 * only the payload shape needs per-event translation — the notable
 * case is `agent.tool.called`, whose event-map payload is a bare
 * `ToolCall` but whose stream wrapper is `{ toolCall }`.
 *
 * Extracted from the `Execution` class in `agent.ts` because it's
 * fully stateless (pure function of event name + payload) and used
 * only from the stream-forwarding path. Keeps the class focused on
 * stateful orchestration.
 */
export function agentEventToStreamEvent<K extends keyof AgentEventMap>(
  event: K,
  payload: AgentEventMap[K],
): StreamEventBody | undefined {
  switch (event) {
    case "agent.starting": {
      const { input } = payload as AgentEventMap["agent.starting"];
      return { type: "agent.starting", input };
    }

    case "agent.trip.started": {
      const { tripIndex, input } =
        payload as AgentEventMap["agent.trip.started"];
      return { type: "agent.trip.started", tripIndex, input };
    }

    case "agent.trip.streaming": {
      const { delta, tripIndex } =
        payload as AgentEventMap["agent.trip.streaming"];
      return { type: "agent.trip.streaming", delta, tripIndex };
    }

    case "agent.tool.calling": {
      const { tool, input, tripIndex } =
        payload as AgentEventMap["agent.tool.calling"];
      return { type: "agent.tool.calling", tool, input, tripIndex };
    }

    case "agent.tool.called": {
      const called = payload as AgentEventMap["agent.tool.called"];
      // Split off the agent's enriched ToolCall record from the tool meta
      // so the stream event surface mirrors the bus payload shape.
      const { tool, ...toolCall } = called;
      return { type: "agent.tool.called", toolCall, tool };
    }

    case "agent.tool.failed": {
      const { tool, error, tripIndex } =
        payload as AgentEventMap["agent.tool.failed"];
      return { type: "agent.tool.failed", tool, error, tripIndex };
    }

    case "agent.trip.completed": {
      const { trip } = payload as AgentEventMap["agent.trip.completed"];
      return { type: "agent.trip.completed", trip };
    }

    case "agent.completed": {
      return { type: "agent.completed" };
    }

    case "agent.error": {
      const { error } = payload as AgentEventMap["agent.error"];
      return { type: "agent.error", error };
    }

    default: {
      return undefined;
    }
  }
}
