import type { AIError } from "../../errors/ai-error";
import type { BaseReport } from "./base-report.type";
import type { BaseResult } from "./base-result.type";
import type { StepSnapshot } from "./step-result.type";

/**
 * Workflow-specific execution report — {@link BaseReport} plus
 * per-step snapshots and the final frozen `ctx.state`.
 *
 * `report.children[]` carries every executable (tool, agent,
 * sub-workflow, supervisor) any step invoked, in invocation order.
 * `report.steps` remains the authoritative record of workflow
 * structure — one entry per defined step — while `children` gives
 * the cross-cutting tree view shared with other primitives.
 */
export type WorkflowReport = BaseReport & {
  /** Discriminator narrowed to the workflow primitive. */
  type: "workflow";
  workflowName: string;
  /** Structural fingerprint — same value exposed on the workflow instance. */
  signature: string;
  /** ISO-8601 timestamp when cancellation was observed, if any. */
  cancelledAt?: string;
  /** Per-step snapshots keyed by step name. */
  steps: Record<string, StepSnapshot>;
  /** Frozen final `ctx.state` at the moment the workflow terminated. */
  state: Readonly<Record<string, unknown>>;
};

/**
 * Result returned by `workflow.execute()` / `workflow.resume()`.
 *
 * Canonical destructuring (mirrors `AgentResult` and
 * `SupervisorResult`):
 *
 *   `const { data, report, usage, error } = await workflow.execute(...)`
 *
 * `data` is populated only when the workflow was defined with an
 * `output: { extract, schema? }` spec and completed successfully. On
 * failure or cancellation it is `undefined`; read `error` and
 * `report.status` instead.
 */
export type WorkflowResult<TOutput = unknown> = BaseResult & {
  type: "workflow";
  data?: TOutput;
  report: WorkflowReport;
  error?: AIError;
};
