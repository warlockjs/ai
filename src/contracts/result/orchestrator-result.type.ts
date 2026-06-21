import type { Message } from "../conversation-message.type";
import type { AgentBranchSnapshot } from "../supervisor/iteration-snapshot.type";
import type { EvaluateResult } from "../supervisor/evaluate-context.type";
import type { SupervisorInput } from "../supervisor/supervisor-input.type";
import type { BaseReport, ReportStatus } from "./base-report.type";
import type { ExecuteResult } from "./execute-result.type";
import type { Usage } from "./usage.type";

/**
 * Discriminator literal the orchestrator stamps onto its report's
 * `type` field (design §15.5). A member of the shared
 * {@link ReportType} closed union in `base-report.type.ts`.
 *
 * {@link OrchestratorReport} re-declares `type` as this literal by
 * *overriding* it (`Omit<BaseReport, "type"> & { type: ... }`) rather than
 * intersecting `BaseReport` with it: intersecting a single literal against
 * `BaseReport.type` (the whole `ReportType` union) lets a strict TypeScript
 * collapse the report to `never` ("conflicting types in some constituents").
 */
export type OrchestratorReportType = "orchestrator";

/**
 * Non-terminal status the orchestrator adds on top of the shared
 * {@link ReportStatus} union — the session is paused waiting for the
 * next user turn (design §15.6, Q9). This is the only non-terminal
 * status across the unified result tree, and is now a member of the
 * shared {@link ReportStatus} union in `base-report.type.ts`.
 */
export type OrchestratorAwaitingStatus = "awaiting-input";

/**
 * Combined status surface for an orchestrator report — every terminal
 * {@link ReportStatus} plus the non-terminal `"awaiting-input"`.
 * Consumers branching on `status === "completed"` must explicitly
 * handle `"awaiting-input"` as a session-continues path, not a failure
 * (§15.6, §18.10).
 */
export type OrchestratorReportStatus = ReportStatus | OrchestratorAwaitingStatus;

/**
 * The result of compacting (summarizing) a slice of session history
 * (design §12, §15.5). Carries the replacement summary message plus the
 * inclusive index range it replaces, so a dev-owned message store can
 * apply the compaction deterministically.
 *
 * Structurally identical to `OrchestratorCommands["compact"]["result"]`
 * — both are kept per the literal §11 / §15.5 spec shapes.
 */
export type CompactionResult = {
  /** The summary message that replaces the compacted range. */
  summary: Message;
  /** Inclusive start index (in the dev's history array) of the replaced range. */
  replacesFromIndex: number;
  /** Inclusive end index of the replaced range. */
  replacesToIndex: number;
};

/**
 * One turn's forensic record on {@link OrchestratorReport.turns}.
 * Mirrors the supervisor's `IterationSnapshot.result` shape so a turn
 * reads uniformly whether it dispatched one agent (`iterate: false`) or
 * delegated to an internal supervisor (`iterate: true`).
 *
 * Frozen (`Readonly`) so consumers can pass snapshots across async
 * boundaries without defensive cloning. `state` is the post-merge,
 * JSON-serializable session state at the end of the turn.
 */
export type TurnSnapshot = Readonly<{
  /** Zero-indexed turn number. */
  turn: number;
  /** The user input that opened this turn. */
  input: SupervisorInput;
  /** Where the dispatch decision came from and its raw value. */
  decision: {
    source: "route" | "router" | "intent.next";
    raw: unknown;
    reasoning?: string;
  };
  /** Per-branch dispatch records keyed by intent (mirrors supervisor). */
  result: Record<string, AgentBranchSnapshot>;
  /** Post-merge session state — JSON-serializable. */
  state: unknown;
  /** Evaluate verdict, if `evaluate` ran this turn. */
  evaluate?: EvaluateResult;
  startedAt: string;
  endedAt: string;
  duration: number;
  usage: Usage;
  /**
   * The dispatched primitive's full report tree — the internal
   * supervisor's report when `iterate: true`, the direct agent's report
   * when `iterate: false`.
   */
  childReport?: BaseReport;
}>;

/**
 * Session-scoped execution report for a single orchestrator turn
 * (design §15.5). Extends {@link BaseReport} with session identity, the
 * turn index, the drift signature, and the per-turn history on
 * `turns[]`.
 *
 * `children[]` carries ONLY the current turn's dispatched primitive
 * reports (Q9). Full session history lives on `turns[]`; walkers that
 * recurse via `children[]` will NOT reach prior turns — intentional.
 *
 * @remarks
 * `type` and `status` are the orchestrator-specific literals — both
 * `"orchestrator"` and `"awaiting-input"` are members of the shared
 * {@link ReportType} / {@link ReportStatus} unions. `type` is OVERRIDDEN
 * via `Omit<BaseReport, "type">` (not intersected) so a strict TypeScript
 * can't collapse the report to `never`; `status` is re-declared compatibly.
 */
export type OrchestratorReport = Omit<BaseReport, "type"> & {
  type: OrchestratorReportType;
  status: OrchestratorReportStatus;
  sessionId: string;
  turnIndex: number;
  /** Orchestrator-scope drift signature (§10.1). */
  signature: string;
  version?: string;
  /** Current turn + (optionally) prior turns, bounded by `keepSnapshots`. */
  turns: TurnSnapshot[];
};

/**
 * Per-turn result returned by `orchestrator.execute()` and resolved by
 * `orchestrator.stream().result` (design §15.5). Extends the unified
 * {@link ExecuteResult} envelope with the session id, the turn index,
 * an optional compaction record, and the orchestrator report.
 *
 * Narrow on `report.type` / `report.status` (not a top-level
 * discriminant string) and read typed `data` for the turn's output.
 *
 * @example
 * const result = await orchestrator.execute(message, { sessionId, history });
 *
 * if (result.error) {
 *   logger.error(result.error.code, { sessionId: result.sessionId });
 *   return;
 * }
 *
 * if (result.report.status === "awaiting-input") {
 *   // session continues — prompt the user for the next turn
 * }
 *
 * if (result.compaction) {
 *   await myMessageStore.applyCompaction(result.sessionId, result.compaction);
 * }
 */
export type OrchestratorResult<TOutput = unknown> = Omit<ExecuteResult<TOutput>, "report"> & {
  sessionId: string;
  turnIndex: number;
  compaction?: CompactionResult;
  report: OrchestratorReport;
};
