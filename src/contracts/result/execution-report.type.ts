import type { BaseReport, ReportStatus } from "./base-report.type";
import type { LLMTrip } from "./llm-trip.type";

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
};
