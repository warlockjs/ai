import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Attachment } from "../attachment.type";
import type { Message } from "../conversation-message.type";
import type { AgentEventMap } from "../events/event-map.type";
import type { Placeholders } from "../placeholders.type";
import type { StreamingToolGuardConfig } from "../streaming-tool-guard-config.type";
import type { SystemPromptContract } from "../system-prompt.contract";
import type { ToolContext } from "../tool.contract";

/**
 * Options passed to AgentContract.execute() to configure a single execution run.
 *
 * @example
 * const result = await agent.execute("Analyze this document", {
 *   history: previousMessages,
 *   attachments: ["/path/to/doc.pdf"],
 *   placeholders: { language: "English" },
 *   output: z.object({ summary: z.string(), keyPoints: z.array(z.string()) }),
 *   on: {
 *     streaming: ({ delta }) => process.stdout.write(delta),
 *     completed: ({ result }) => console.log("Done"),
 *   },
 * });
 */
export type AgentExecuteOptions<TOutput = unknown> = {
  /** Prior conversation messages to prepend as context */
  history?: Message[];
  /** Files or URLs to attach to the message */
  attachments?: Attachment[];
  /** Values to inject into {{mustache}} placeholders in prompts */
  placeholders?: Placeholders;
  /**
   * Standard Schema for structured output extraction.
   * When provided, the agent will attempt to return typed data in result.data.
   */
  output?: StandardSchemaV1<TOutput>;
  /**
   * Hand-crafted JSON Schema used to drive native structured-output mode
   * (OpenAI `response_format: json_schema`, etc.) and to embed in the
   * soft system-prompt instruction.
   *
   * Primary use case: libraries whose JSON Schema output isn't
   * automatically extractable by `extractJsonSchema` — notably Zod,
   * which ships `z.toJSONSchema` as a top-level module function rather
   * than a property on the schema. Pass the converter's output here and
   * the agent will use it verbatim, skipping extraction.
   *
   * When both `output` and `responseSchema` are set, `responseSchema`
   * wins — `output` still runs for client-side validation into
   * `result.data`, but the wire-level schema sent to the model is
   * whatever was passed here.
   *
   * @example
   * import { z, toJSONSchema } from "zod";
   * const schema = z.object({ summary: z.string() });
   * await agent.execute(input, {
   *   output: schema,
   *   responseSchema: toJSONSchema(schema),
   * });
   */
  responseSchema?: Record<string, unknown>;
  /**
   * Opt-in self-repair when the model's response fails to parse or
   * validate against `output`. When enabled, the agent appends the bad
   * assistant message plus a corrective user message to the conversation
   * and re-invokes the model up to `maxAttempts` times, re-parsing on
   * each attempt. Disabled by default — schema failures normally surface
   * a real prompt/model issue worth seeing rather than silently retrying.
   *
   * Each repair attempt counts as a normal trip and is bounded by the
   * agent's `maxTrips` cap (belt-and-suspenders against runaway loops).
   *
   * Only active when `output` (or `responseSchema`) is set; ignored
   * otherwise.
   *
   * @example
   * await agent.execute(input, {
   *   output: schema,
   *   repair: { maxAttempts: 1 },
   * });
   */
  repair?: {
    /** Max number of re-ask attempts after the initial failure. Default 1. */
    maxAttempts?: number;
  };
  /** Override the agent's system prompt for this execution */
  systemPrompt?: SystemPromptContract;
  /**
   * Cancellation handle. When `signal.aborted` becomes true the agent
   * short-circuits at the next trip boundary and returns with
   * `report.status = "cancelled"` + `result.error` set to an
   * `AgentExecutionError` carrying the abort reason. Mid-trip abort
   * is best-effort — it relies on the underlying provider adapter
   * threading `signal` into its HTTP client. The workflow engine
   * passes its own signal through automatically when a step has an
   * `agent`.
   */
  signal?: AbortSignal;
  /** Event handlers for observing execution progress */
  on?: Partial<{
    [K in keyof AgentEventMap]: (payload: AgentEventMap[K]) => void;
  }>;
  /**
   * Tool context threaded into every `tool.invoke()` call this agent
   * runs (Phase 5 / decisions §35). Tools mutate `ctx.artifacts` to
   * contribute system-only side data; the supervisor that supplied
   * the ctx merges that bag into state at iteration end.
   *
   * Typically set by the supervisor's dispatch loop, not by user
   * code. Standalone callers may omit it — the framework supplies a
   * degraded `{ artifacts: {} }` so single-arg legacy tools keep
   * working unchanged.
   */
  toolCtx?: ToolContext;
  /**
   * Per-call override for the stream-time tool-call guard. Wins over
   * `AgentConfig.streamingToolGuard` when set. Pass `undefined` to
   * disable for a single call when the agent-level config has the
   * guard enabled (e.g. a one-off "give me a raw JSON config" call
   * where the buffering delay isn't worth it).
   */
  streamingToolGuard?: StreamingToolGuardConfig;
  /**
   * Opaque caller-supplied identifier that groups multiple `execute()`
   * calls into one conceptual user session / request. Mirrored onto
   * every report node this run produces (and every nested executable
   * it invokes via `asTool` wrappers) so flat queries like "total
   * spend for user X this morning" don't need to walk the tree.
   *
   * Auto-propagated to composite primitives — an inner supervisor
   * dispatched via `asTool` inherits the outer agent's `sessionId`.
   * Execution state (artifacts, snapshots) stays isolated; only the
   * observability identity is shared.
   */
  sessionId?: string;
};
