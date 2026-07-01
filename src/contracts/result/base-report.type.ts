import type { AIError } from "../../errors/ai-error";
import type { AttemptEntry } from "./attempt-entry.type";
import type { Usage } from "./usage.type";

/**
 * Wire-format version stamped on every root `BaseReport`. Bumped only
 * when we make a BREAKING change to the report shape (field removed,
 * required-ness flipped, semantics changed). Additive changes (new
 * optional fields) do not bump.
 *
 * Panoptic and other downstream consumers branch on this to parse
 * old stored reports with their original-shape rules.
 *
 * Current: **1** — initial Panoptic-readiness shape.
 */
export const REPORT_SCHEMA_VERSION = 1;

/**
 * Discriminator for the kind of executable that produced a given
 * {@link BaseReport}. Forms a closed union so consumers can narrow on
 * the tree without string-matching on `name`.
 */
export type ReportType =
  | "tool"
  | "callback"
  | "agent"
  | "workflow"
  | "supervisor"
  | "team"
  | "orchestrator"
  | "batch"
  | "planner"
  | "image"
  | "speech"
  | "transcription"
  | "video"
  | "realtime";

/**
 * Terminal status every executable primitive reports. Unified across
 * tools, agents, workflows, and supervisors so dashboards and
 * generic traversal helpers don't special-case per primitive.
 *
 * - `"completed"` — ran to natural end with a usable result.
 * - `"failed"` — aborted mid-run or finished without a usable result
 *   (crash, schema failure, max-trips, etc.). The
 *   accompanying `error` on the envelope carries the typed cause.
 * - `"cancelled"` — caller aborted before completion via `AbortSignal`.
 * - `"max-iterations"` — supervisor-specific termination when the
 *   iteration cap was hit without an explicit `END` / `satisfied`.
 *   Harmless on non-supervisor reports; keeping it on the shared
 *   union lets consumers write one `switch` for every status.
 * - `"awaiting-input"` — orchestrator-specific NON-terminal status: the
 *   session is paused waiting for the next user turn (§15.6). The only
 *   non-terminal member of this union; consumers branching on
 *   `status === "completed"` must treat it as a session-continues path,
 *   not a failure. Harmless on non-orchestrator reports.
 * - `"awaiting-approval"` — planner-specific NON-terminal status: a
 *   `mode: "plan-only"` run generated and validated a plan but executed
 *   nothing, pending sign-off (the plan rides on `result.plan`). Mirrors
 *   `"awaiting-input"` at the plan boundary. Harmless on non-planner
 *   reports.
 */
export type ReportStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "max-iterations"
  | "awaiting-input"
  | "awaiting-approval";

/**
 * Universal execution report shared by every primitive. Per-primitive
 * report types extend this with their own domain-specific fields
 * (agent trips, workflow steps, supervisor iteration snapshots) while
 * keeping the root fields identical. Recursion happens through
 * {@link BaseReport.children} — any executable this node invoked
 * contributes its own full report here, producing a walkable tree of
 * the entire run.
 *
 * **Usage rollup.** `usage` at every node equals this node's own cost
 * plus the sum of each child's `usage`. Leaves (tools) contribute
 * zero own-cost; composites contribute their direct LLM spend only,
 * with children covering everything delegated.
 *
 * @example
 * function totalCost(report: BaseReport): number {
 *   return report.usage.total;
 * }
 *
 * function walk(report: BaseReport, depth = 0): void {
 *   console.log(`${"  ".repeat(depth)}${report.type} "${report.name}" — ${report.status}`);
 *   for (const child of report.children) walk(child, depth + 1);
 * }
 */
export type BaseReport = {
  /** Stable id for this execution node. Generated per `execute()`/`invoke()` call. */
  runId: string;
  /**
   * Run-id of the immediate parent execution node, when this node was
   * invoked as part of a larger run (e.g. a tool dispatched by an
   * agent; an agent dispatched by a supervisor; an inner primitive
   * wrapped via `asTool()`). Absent on root nodes.
   *
   * Lets Panoptic and other flat-row consumers reconstruct the tree
   * without traversing `children[]` in memory.
   */
  parentRunId?: string;
  /**
   * Run-id of the top-level execution this node belongs to. Equals
   * `runId` on the root node, and is propagated downward to every
   * descendant. Used to slice flat report tables back into per-run
   * groupings.
   */
  rootRunId: string;
  /** Executable identity — the tool/agent/workflow/supervisor name. */
  name: string;
  /**
   * Dev-curated version string mirrored from the primitive's config
   * (`AgentConfig.version`, `ToolConfig.version`, etc.). Free-form —
   * the framework neither parses nor compares it. Stored verbatim on
   * every report so trip-archive queries can distinguish runs of
   * "agent X v2.1" from "agent X v2.2" even when name + signature
   * are identical.
   *
   * Stays `undefined` when the dev didn't declare one — never
   * auto-defaulted.
   */
  version?: string;
  /**
   * Caller-supplied identifier that groups multiple `.execute()` calls
   * into one conceptual user session / request. Propagated to every
   * descendant report node so flat queries ("total spend for session
   * X today") work without joining the tree.
   *
   * Threaded from `execute()` options on every primitive. Optional —
   * absent when the caller didn't supply one.
   */
  sessionId?: string;
  /** Discriminator for the kind of executable that produced this report. */
  type: ReportType;
  /** Terminal status of this execution. */
  status: ReportStatus;
  /**
   * Terminal error stamped on a `failed` / `cancelled` node so the typed
   * cause travels WITH the report tree — not only on the result envelope.
   * Essential for the observe path: an {@link import("../../observe/observer.contract").Observer}
   * receives `collect(report)` with no envelope, so a failed root would
   * otherwise expose `status` with no error type/message. Child tool nodes
   * already carry their error this way (`ToolCall.error`); root primitives
   * (agent / workflow / supervisor / orchestrator / planner) stamp it here
   * too. Absent on a `completed` node. Panoptic normalizes it to a JSON-safe
   * span error during projection — the raw `AIError` never has to serialize.
   */
  error?: AIError;
  /** ISO-8601 wall-clock timestamp when execution began. */
  startedAt: string;
  /** ISO-8601 wall-clock timestamp when execution finished. */
  endedAt: string;
  /** Monotonic duration in milliseconds — `performance.now()` delta. */
  duration: number;
  /** Rolled-up usage: own cost + sum of `children[].usage`. */
  usage: Usage;
  /**
   * Reports of every executable invoked by this node, in invocation
   * order. Empty for leaves (pure tools) and for executables that
   * didn't delegate work.
   */
  children: BaseReport[];
  /**
   * Retry history when middleware (or, for workflow steps, the engine
   * itself) retried this node before it either succeeded or gave up.
   * Absent when zero retries happened — keeps the common-case payload
   * lean. The surviving (final) attempt is NOT duplicated here; its
   * outcome is the report's own `status` / timing.
   */
  attempts?: AttemptEntry[];
  /**
   * Wire-format version of this report shape. Only present on root
   * report nodes — implies the same version for the whole tree.
   * Panoptic / archive consumers branch on this to parse old reports
   * with their original-shape rules.
   *
   * Always equals {@link REPORT_SCHEMA_VERSION} at write time.
   */
  reportSchemaVersion?: number;
};
