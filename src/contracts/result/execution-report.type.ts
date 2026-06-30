import type { ModelToolCallRequest } from "../model-tool-call-request.type";
import type { BaseReport, ReportStatus } from "./base-report.type";
import type { LLMTrip } from "./llm-trip.type";

/**
 * One normalized turn of an agent's assembled conversation, captured
 * onto {@link AgentReport.messages} when `captureMessages` is enabled.
 *
 * A faithful, JSON-safe projection of the runtime `Message`: the `tool`
 * role returns a tool's output; an `assistant` turn that requested tools
 * carries `toolCalls`; a `tool` turn carries the `toolCallId` it answers.
 * `content` is always a string here (the runtime stringifies tool
 * results and flattens text), so the captured array survives JSON
 * serialization and downstream exporters forward it verbatim.
 */
export type CapturedMessage = {
  /** Who produced this turn. */
  role: "system" | "user" | "assistant" | "tool";
  /** The turn's text content (tool results are stringified JSON). */
  content: string;
  /** Tool calls the assistant requested — present only on assistant turns that triggered tools. */
  toolCalls?: ModelToolCallRequest[];
  /** Provider tool-call id this turn answers — present only on tool-result turns. */
  toolCallId?: string;
};

/**
 * Terminal status alias retained for backwards-compatibility with
 * existing imports. Use {@link ReportStatus} directly for new code —
 * both point at the same unified union across every primitive.
 */
export type ExecutionStatus = ReportStatus;

/**
 * Alias kept for callers referencing the pre-3.1 shared timing block.
 * Structurally a {@link BaseReport} — use that for new code.
 */
export type ExecutionReport = BaseReport;

/**
 * Agent-specific execution report — {@link BaseReport} plus the LLM
 * trip history for a single `agent.execute()` call.
 *
 * Tool dispatches that previously lived under `toolCalls[]` are now
 * reported as child `BaseReport` nodes on
 * {@link BaseReport.children} — filter by `type === "tool"` to isolate
 * leaf tool calls, or walk the full tree to see every nested
 * executable. Trips stay here because they describe the agent's
 * **internal** turn structure (LLM round-trips), not child executions.
 *
 * @example
 * const { report } = await agent.execute("hi");
 * console.log(report.status, report.duration, report.trips.length);
 *
 * const toolCalls = report.children.filter((c) => c.type === "tool");
 * const nestedAgents = report.children.filter((c) => c.type === "agent");
 */
export type AgentReport = BaseReport & {
  /**
   * Identity of the model the agent ran against. Captured from the
   * `ModelContract` at result-build time so consumers can attribute
   * cost, latency, and behavior to the right upstream — especially
   * useful when the same provider package fronts multiple labels
   * (e.g. `openai` vs `openrouter` vs `azure` via the OpenAI adapter).
   */
  model: { name: string; provider: string };
  /** Every LLM round-trip that happened during execution. */
  trips: LLMTrip[];
  /**
   * The resolved system-prompt text sent as the `role: "system"` message
   * (persona + instructions + any auto-appended structured-output
   * instruction). Captured for observability; absent when the agent ran
   * without a system prompt. Note `LLMTrip.input` holds only the user
   * message — the system prompt is recorded here.
   */
  systemPrompt?: string;
  /**
   * Registry name of the named `SystemPromptContract` this run resolved —
   * its `meta.name`, addressable in `ai.prompts`. Present ONLY when the agent
   * ran against a *named* prompt; absent for a raw-string prompt, an anonymous
   * contract, or no prompt at all. Together with {@link AgentReport.promptVersion}
   * it links a run to the exact prompt version that produced it, so downstream
   * consumers (Panoptic) can group / filter runs by `promptName@promptVersion`.
   */
  promptName?: string;
  /**
   * Registry version label of the named prompt this run resolved — its
   * `meta.version` (defaulting to `"1"` when the prompt is named but carries
   * no explicit version, mirroring the `ai.prompts` registry default). Present
   * ONLY alongside {@link AgentReport.promptName}.
   */
  promptVersion?: string;
  /**
   * The full assembled multi-turn conversation — every role
   * (system / user / assistant / tool), every trip — captured as a
   * {@link CapturedMessage}[]. Present ONLY when the agent's
   * `captureMessages` option was set; absent otherwise (byte-for-byte
   * as before). Opt-in because messages can be large and sensitive.
   * Unlike `trips[].input` (which stubs non-first trips with
   * `"[tool results]"`), this preserves the real turn array.
   */
  messages?: CapturedMessage[];
};
