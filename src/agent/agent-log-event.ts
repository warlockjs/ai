import type { Logger } from "@warlock.js/logger";
import type { AgentEventMap } from "../contracts/events/event-map.type";
import type { LLMTrip } from "../contracts/result/llm-trip.type";
import type { ToolCall } from "../contracts/result/tool-call.type";
import type { Usage } from "../contracts/result/usage.type";

/**
 * Aggregate snapshot the agent-level log entries need at emission time
 * (agent completion + model name + running totals). Passed instead of
 * storing a back-reference to the Execution class — keeps this helper
 * a pure function.
 */
export type AgentLogContext = {
  /** Dotted logger module, e.g. `"ai.agent.my-writer"`. */
  module: string;
  /** Maximum trips configured for this run — logged once on `agent.starting`. */
  maxTrips: number;
  /** Model identifier — logged once on `agent.starting`. */
  modelName: string;
  /** Final running usage totals at the moment `agent.completed` fires. */
  totalUsage: Usage;
  /** Monotonic duration (ms) since start at the moment `agent.completed` fires. */
  totalDurationMs: number;
  /** All trips recorded so far — logged count on `agent.completed`. */
  trips: LLMTrip[];
  /** All tool calls recorded so far — logged count on `agent.completed`. */
  toolCalls: ToolCall[];
};

/**
 * Structured logging for agent lifecycle events. Mirrors
 * `Execution.emit`'s call sites without touching class state — the
 * caller passes the ambient snapshot in `ctx`, we route each event to
 * the right logger level and enrich with the per-event forensic
 * detail.
 *
 * Log-level convention:
 * - `info` — lifecycle boundaries (agent starting / completed) users
 *   want to see at default verbosity
 * - `debug` — per-trip + per-tool progress (hot-path, opt-in)
 * - `success` — trip completion + tool success (terminal per-step state)
 * - `warn` — tool failures (recoverable, agent loop continues)
 * - `error` — agent-level terminal errors
 *
 * Streaming deltas (`agent.trip.streaming`) are intentionally skipped
 * to avoid token-granularity log spam.
 */
export function logAgentEvent<K extends keyof AgentEventMap>(
  logger: Logger,
  ctx: AgentLogContext,
  event: K,
  payload: AgentEventMap[K],
): void {
  const action = event.replace(/^agent\./, "");

  switch (event) {
    case "agent.starting": {
      const { input } = payload as AgentEventMap["agent.starting"];
      logger.info(ctx.module, action, "agent starting", {
        maxTrips: ctx.maxTrips,
        model: ctx.modelName,
        inputLength: input.length,
      });
      return;
    }

    case "agent.trip.started": {
      const { tripIndex } = payload as AgentEventMap["agent.trip.started"];
      logger.debug(ctx.module, action, "trip started", { tripIndex });
      return;
    }

    case "agent.trip.streaming": {
      // Deltas are too high-volume to log at token granularity.
      // Skipped on purpose; debug level still fires on trip boundaries.
      return;
    }

    case "agent.trip.completed": {
      const { trip } = payload as AgentEventMap["agent.trip.completed"];
      logger.success(ctx.module, action, "trip completed", {
        tripIndex: trip.index,
        duration: trip.duration,
        usage: trip.usage,
        finishReason: trip.finishReason,
      });
      return;
    }

    case "agent.tool.calling": {
      const { tool, tripIndex } =
        payload as AgentEventMap["agent.tool.calling"];
      logger.debug(ctx.module, action, `calling tool "${tool.name}"`, {
        tool: tool.name,
        action: tool.action,
        tripIndex,
      });
      return;
    }

    case "agent.tool.called": {
      const toolCall = payload as AgentEventMap["agent.tool.called"];
      logger.success(ctx.module, action, `tool "${toolCall.name}" finished`, {
        tool: toolCall.name,
        duration: toolCall.duration,
        tripIndex: toolCall.tripIndex,
      });
      return;
    }

    case "agent.tool.failed": {
      const { tool, error, tripIndex } =
        payload as AgentEventMap["agent.tool.failed"];

      logger.warn(ctx.module, action, `tool "${tool.name}" failed`, {
        tool: tool.name,
        tripIndex,
        error: {
          code: error.code,
          message: error.message,
          name: error.name,
          stack: error.stack,
        },
      });
      return;
    }

    case "agent.completed": {
      logger.info(ctx.module, action, "agent completed", {
        duration: ctx.totalDurationMs,
        usage: ctx.totalUsage,
        trips: ctx.trips.length,
        tools: ctx.toolCalls.length,
      });
      return;
    }

    case "agent.error": {
      const { error } = payload as AgentEventMap["agent.error"];
      logger.error(ctx.module, action, error.message, {
        code: error.code,
        context: error.context,
      });
      return;
    }
  }
}
