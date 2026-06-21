import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { CompleteEvent } from "../contracts/events/complete-event.type";
import type { AgentEventMap } from "../contracts/events/event-map.type";
import type { UsageEvent } from "../contracts/events/usage-event.type";
import type { AgentMiddleware } from "../contracts/middleware";
import type { ModelCallOptions, ModelContract } from "../contracts/model.contract";
import type { Placeholders } from "../contracts/placeholders.type";
import type { StreamingToolGuardConfig } from "../contracts/streaming-tool-guard-config.type";
import type { SystemPromptContract } from "../contracts/system-prompt.contract";
import type { AgentToolEntry } from "../tool/executable-as-tool";

/**
 * Map of factory-level event handlers. Every key is optional; handlers
 * registered here fire on every `execute()` / `stream()` call made
 * through this agent, before instance-level and per-call handlers.
 */
export type AgentEventHandlers = Partial<{
  [K in keyof AgentEventMap]: (payload: AgentEventMap[K]) => void;
}>;

/**
 * Configuration passed to `agent()` to create an AgentContract instance.
 *
 * @example
 * const config: AgentConfig<{ answer: string }> = {
 *   model: openai.model({ name: "gpt-4o" }),
 *   systemPrompt: "You are a helpful assistant.",
 *   tools: [searchTool, calculatorTool],
 *   placeholders: { language: "English" },
 *   maxTrips: 5,
 *   modelOptions: { temperature: 0.2 },
 * };
 *
 * @example
 * // With a SystemPromptContract instance
 * const config: AgentConfig = {
 *   model: myModel,
 *   systemPrompt: systemPrompt
 *     .persona("You are Alex, a TypeScript expert")
 *     .instruction("Always respond in {{language|English}}"),
 *   placeholders: { language: "Arabic" },
 * };
 */
export type AgentConfig<TOutput = unknown> = {
  /**
   * Stable identifier for this agent. Optional — when absent, the
   * factory synthesizes a deterministic anonymous fingerprint
   * (`anon_<provider>_<model>[_<tool>+...]`) used for logs and trace
   * attribution.
   *
   * **Required at real boundaries:** boundaries that depend on *stable*
   * agent identity (workflow signature drift detection when used as a
   * step's `agent`, `agent.asTool()` wrapper) throw `WorkflowError` /
   * `ToolError` if the agent is still anonymous. Pass a name whenever
   * the agent will be composed into a higher-level primitive.
   */
  name?: string;
  /**
   * Short natural-language summary of what this agent does — the "when
   * would a router pick this?" line. Used by `ai.supervisor()`'s router
   * prompt and by `agent.asTool()` as the default tool description.
   * Optional at the agent level; entries in a supervisor's `agents` map
   * may override it per-use.
   */
  description?: string;
  /**
   * Dev-curated version string for this agent — free-form (semver,
   * date, hash, anything). Stored on every report node this agent
   * produces so trip-archive consumers can distinguish runs of "agent
   * X v2.1" from "agent X v2.2" even when name + signature are
   * identical.
   *
   * Bump when you change behavior in a way that matters to stored
   * reports — prompt rewrite, model swap, tool list change. The
   * framework neither parses nor compares it; signature drift
   * detection remains independent.
   */
  version?: string;
  /** The model to use for LLM calls */
  model: ModelContract;
  /**
   * System prompt for the agent. A plain string is treated as a single instruction.
   * A SystemPromptContract gives full builder control with placeholder support.
   */
  systemPrompt?: SystemPromptContract | string;
  /**
   * Tools exposed to the LLM during execution.
   *
   * Accepts both shapes interchangeably:
   * - A built `ToolContract` — from `ai.tool(...)` or an explicit
   *   `.asTool(...)` wrapper on an executable.
   * - A raw executable primitive (`AgentContract` / `WorkflowInstance`
   *   / `SupervisorContract`) — auto-adapted into a `ToolContract` at
   *   factory time. The tool manifest is derived from the executable's
   *   `name` + `description` + (optional) `inputSchema`; dispatch flows
   *   through its `execute()`. `.asTool()` remains fully supported and
   *   takes precedence when you need a custom name / schema per use.
   */
  tools?: AgentToolEntry<any, any>[];
  /** Placeholder values merged into system prompt templates */
  placeholders?: Placeholders;
  /**
   * Maximum number of LLM trips before aborting with an error.
   * Prevents infinite tool-call loops. Defaults to 10.
   */
  maxTrips?: number;
  /** Base model call options merged with per-execute options (execute wins on conflict) */
  modelOptions?: ModelCallOptions;
  /**
   * Default Standard Schema for structured output. Bakes the output
   * contract into the agent's identity for agents whose shape never
   * varies per call (title generators, intent classifiers, routers).
   * `execute()` / `stream()` callers can still pass `options.output`
   * to override for a single run — call-site fully replaces this,
   * no merging.
   */
  output?: StandardSchemaV1<TOutput>;
  /**
   * Factory-level event handlers. Fire before instance-level `.on()`
   * additions and before per-call `options.on` handlers on every
   * `execute()` / `stream()` call.
   */
  on?: AgentEventHandlers;
  /**
   * Agent-level middleware pipeline. Each middleware may hook any
   * subset of three levels: `execute` (wraps the whole run), `trip`
   * (wraps each LLM round-trip), `tool` (wraps each tool dispatch).
   *
   * Registration order is execution order — `before` hooks run
   * top-down, `after` / `onError` run bottom-up (onion model).
   * Canonical install order: `[cache, budget, guardrail, observability]`.
   *
   * See `AgentMiddleware` for the full contract.
   */
  middleware?: AgentMiddleware[];
  /**
   * Opt-in stream-time guard that recovers a tool call when the model
   * emits its structured input as **text** in the content channel
   * instead of as a structured tool-call. Off when absent (faithful
   * relay); `{}` enables it with defaults. Per-call
   * `AgentExecuteOptions.streamingToolGuard` overrides this on a single
   * `execute()` / `stream()` call. See {@link StreamingToolGuardConfig}
   * for the full contract — limitations, latency tradeoff, matcher
   * tier.
   */
  streamingToolGuard?: StreamingToolGuardConfig;
  /**
   * Per-trip usage callback. Fires once after every LLM round-trip
   * (initial trip, continuation trips after tool results, repair
   * trips) with a flat `{ runId, tripIndex, model, provider, usage,
   * timestamp }` payload — pre-packaged so cost-ledger code can write
   * one row per trip without joining identity from elsewhere.
   *
   * Sync or async. Errors thrown inside the hook are swallowed so
   * consumer bugs cannot crash the agent loop.
   *
   * Distinct from the existing `agent.trip.completed` event — that
   * event still fires for general subscribers; `onUsage` is the
   * dedicated cost-attribution surface.
   */
  onUsage?: (event: UsageEvent) => void | Promise<void>;
  /**
   * Per-execution completion callback. Fires once at the end of every
   * `agent.execute()` / `agent.stream()` call — completed, failed,
   * cancelled. Receives the full `AgentResult` plus pre-extracted
   * `runId` and end-to-end `durationMs`. Audit-log code subscribes
   * here to write one `ai_runs` row per execution with the (redacted)
   * report.
   *
   * Sync or async. Errors thrown inside the hook are swallowed.
   *
   * Distinct from the existing `agent.completed` event — both fire.
   */
  onComplete?: (event: CompleteEvent<TOutput>) => void | Promise<void>;
};
