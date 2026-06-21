import type { AIError } from "../../errors/ai-error";
import type { BaseReport } from "./base-report.type";

/**
 * Forensic record of a single leaf-tool dispatch inside an agent's
 * execution. Structurally a {@link BaseReport} (`type: "tool"`) with
 * agent-level enrichments — the originating LLM trip index, the raw
 * input the model emitted, the concrete output returned, and the
 * typed error if any.
 *
 * Because `ToolCall` is a `BaseReport`, it drops directly into
 * `AgentReport.children[]` alongside nested agent/workflow/supervisor
 * reports, keeping the recursive tree uniform. It also powers the
 * live `agent.tool.called` event + stream payloads so subscribers see
 * the same shape during execution as they read post-hoc.
 *
 * @example
 * const toolCalls = agentReport.children.filter(
 *   (c): c is ToolCall => c.type === "tool",
 * );
 * for (const call of toolCalls) {
 *   console.log(call.name, call.tripIndex, call.input, call.output);
 * }
 */
export type ToolCall = BaseReport & {
  /** Discriminator already fixed on BaseReport, narrowed to "tool" here. */
  type: "tool";
  /** Which LLM trip triggered this tool call (0-indexed). */
  tripIndex: number;
  /** Input passed to the tool (validated args from the model's request). */
  input: unknown;
  /** Output returned by the tool (undefined if an error occurred). */
  output?: unknown;
  /** Typed AI error thrown during dispatch (validation or execute), if any. */
  error?: AIError;
  /**
   * Provenance marker copied from the originating
   * `ModelToolCallRequest.recoveredFrom`. Present only when this
   * dispatch came from the streaming tool-call guard recovering a
   * leaked JSON envelope from the text channel; absent for real
   * provider tool-calls. Telemetry consumers branch on this to compute
   * per-model leak rate.
   */
  recoveredFrom?: "stream-text";
};
