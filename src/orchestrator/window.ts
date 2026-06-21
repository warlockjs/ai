import type { Message } from "../contracts/conversation-message.type";
import type { OrchestratorEngineContext } from "./engine-context.type";

/**
 * Framework-default history windows (orchestrator.md §4 Phase 4 — "5
 * for the router, 15 for intents"). Applied when neither a per-entity
 * override nor a tier default is configured.
 */
export const DEFAULT_ROUTER_WINDOW = 5;
export const DEFAULT_AGENTS_WINDOW = 15;

/** A history window: keep the last N messages, or a custom slicer. */
export type HistoryWindowValue =
  | number
  | ((messages: Message[]) => Message[]);

/**
 * The windowed history bound into each consumer for a turn (§4 Phase
 * 4). Applied per-dispatchable, independently: the router can see a
 * different slice than the dispatched agents.
 */
export type WindowedHistory = {
  /** Slice bound into the router's context. */
  router: Message[];
  /** Slice forwarded to every dispatched intent/agent. */
  agents: Message[];
};

/**
 * Apply a single window to a history array. A number keeps the last N
 * messages (most recent, chronological order preserved); a callback
 * takes full control of the slice (the escape hatch for token-counting
 * or semantic windowing — §4 Phase 4). `N <= 0` keeps nothing.
 */
export function applyWindow(
  messages: Message[],
  window: HistoryWindowValue,
): Message[] {
  if (typeof window === "function") {
    return window(messages);
  }

  if (window <= 0) {
    return [];
  }

  if (messages.length <= window) {
    return messages.slice();
  }

  return messages.slice(messages.length - window);
}

/**
 * Phase 4 — window history (orchestrator.md §3 / §4 Phase 4). Applies
 * the `historyWindow` cascade to the dev-supplied `history` before it
 * is bound into the router and the dispatched agents. Two tiers,
 * evaluated per-role:
 *
 * 1. Tier default — `historyWindow.router` / `historyWindow.agents`.
 * 2. Framework default — `5` for the router, `15` for agents.
 *
 * (The first cascade layer — per-entity overrides on individual
 * intents / the router entry — is the supervisor's concern: it lives
 * on the intent entries the orchestrator spreads into the supervisor,
 * and the supervisor applies it to the agent-windowed slice this phase
 * produces. The orchestrator owns only the two role-level tiers.)
 *
 * Emits `orchestrator.history.windowed` with the agent-slice message
 * count. Pure aside from the event — returns the per-role slices for
 * the dispatch phase to thread through.
 */
export function windowHistory(
  ctx: OrchestratorEngineContext,
  sessionId: string,
  history: Message[],
): WindowedHistory {
  const config = ctx.config.historyWindow;

  const router = applyWindow(history, config?.router ?? DEFAULT_ROUTER_WINDOW);
  const agents = applyWindow(history, config?.agents ?? DEFAULT_AGENTS_WINDOW);

  ctx.emitter.emit("orchestrator.history.windowed", {
    sessionId,
    messageCount: agents.length,
  });

  return { router, agents };
}
