import type { Usage } from "../result/usage.type";

/**
 * Per-trip telemetry payload for the `onUsage` agent hook (T1 of the
 * 2026-05-08 ai-usage/runs/state/cart plan).
 *
 * Fired once after every LLM round-trip — including the trip that
 * caused a tool call, the continuation trip after the tool result,
 * and any repair trips. Cost-ledger code subscribes here to write one
 * row per trip with stable identity (`runId` + `tripIndex`) so usage
 * rows can be joined back to a parent `ai_runs` row written by the
 * `onComplete` hook.
 *
 * Provider identity is split: `model.name` is the upstream model
 * identifier (e.g. `gpt-4o-mini`); `model.provider` is the SDK label
 * (`openai`, `openrouter`, `anthropic`). Both are stable across the
 * agent run — they reflect the model the agent was constructed with.
 *
 * `usage.cachedTokens`, when populated, is the subset of `usage.input`
 * served from the provider's prompt cache. Costs price it separately
 * from full-rate input tokens.
 *
 * Hook handlers may be sync or async. Errors thrown inside the hook
 * are swallowed so consumer bugs cannot crash the agent loop.
 */
export type UsageEvent = {
  /** Run-scoped identifier (matches `AgentResult.report.runId`). */
  runId: string;
  /** 0-indexed position of this trip within the run. */
  tripIndex: number;
  /** Model identity for this trip. */
  model: { name: string; provider: string };
  /** Token counts for this trip. */
  usage: Usage;
  /** Wall-clock timestamp the trip ended (ISO 8601 string). */
  timestamp: string;
};
