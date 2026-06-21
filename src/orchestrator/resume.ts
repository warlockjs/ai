import type { OrchestratorResumeOptions } from "../contracts/orchestrator/orchestrator-execute-options.type";
import type {
  OrchestratorReport,
  OrchestratorReportStatus,
  OrchestratorResult,
  TurnSnapshot,
} from "../contracts/result/orchestrator-result.type";
import type { BaseReport } from "../contracts/result/base-report.type";
import { summarizeRoute } from "./checkpoint";
import { deriveRunId, dispatchTurn } from "./dispatch";
import type { OrchestratorEngineContext } from "./engine-context.type";
import { loadSession } from "./load";

/**
 * Hooks the resume protocol borrows from the execution module so it can
 * reuse the drift check, report assembly, status mapping, terminal
 * event emission, and checkpoint persistence without a circular import
 * (execution.ts owns those; resume.ts is called by it).
 */
export type ResumeHooks = {
  assertNoDrift(loadedSignature: string | undefined): void;
  buildReport(
    turnIndex: number,
    status: OrchestratorReportStatus,
    turnSnapshot: TurnSnapshot | undefined,
    childReport: BaseReport | undefined,
  ): OrchestratorReport;
  deriveStatus(childStatus: BaseReport["status"]): OrchestratorReportStatus;
  emitTerminal(turnIndex: number, status: OrchestratorReportStatus): void;
  persist(
    turnIndex: number,
    state: unknown,
    lastRoute: string | string[] | null,
    summarizedThrough: number | null,
  ): Promise<unknown>;
};

/**
 * §9 resume protocol. Detects and drains an interrupted `iterate: true`
 * turn:
 *
 * 1. Load the latest checkpoint (§9.1 step 1).
 * 2. Compute the candidate `runId` for the NEXT turn — the one that was
 *    in flight — `${sessionId}.${version}.${turn_index + 1}` (§9.1 step 2).
 * 3. Load the supervisor snapshot for that runId (§9.1 step 3).
 * 4. If a still-`running` snapshot exists, resume the supervisor, persist
 *    a fresh checkpoint for `turn_index + 1`, and return the result
 *    (§9.1 step 4).
 * 5. Otherwise return `null` — nothing in flight; the caller proceeds to
 *    `execute()` normally (§9.1 step 5, §9.3 drain idempotency).
 *
 * Runs the same Phase 2 drift check as `execute()` (§9.4). Resume is a
 * no-op for `iterate: false` orchestrators (no SnapshotStore, nothing to
 * resume) — it returns `null`.
 */
export async function resolveResume<TOutput, TState>(
  ctx: OrchestratorEngineContext<TOutput, TState>,
  sessionId: string,
  options: OrchestratorResumeOptions | undefined,
  hooks: ResumeHooks,
): Promise<OrchestratorResult<TOutput> | null> {
  if (!ctx.snapshotStore || ctx.config.iterate !== true) {
    return null;
  }

  const loaded = await loadSession(ctx, sessionId);

  // Drift guard — same as execute() (§9.4).
  hooks.assertNoDrift(loaded.record?.signature);

  // The in-flight turn is the one AFTER the last settled checkpoint.
  const resumedTurnIndex = (loaded.record?.turn_index ?? -1) + 1;
  const runId = deriveRunId(sessionId, ctx.config.version, resumedTurnIndex);

  const snapshot = await ctx.snapshotStore.load(runId);

  if (!snapshot || snapshot.status !== "running") {
    return null;
  }

  ctx.emitter.emit("orchestrator.turn.starting", {
    sessionId,
    turnIndex: resumedTurnIndex,
  });

  // Re-dispatch: dispatchTurn detects the in-flight snapshot for this
  // runId and calls supervisor.resume() rather than execute() (§5 step 5).
  const { result, state, turnSnapshot } = await dispatchTurn<TOutput, TState>({
    ctx,
    sessionId,
    input: snapshot.input,
    seedState: loaded.state,
    turnIndex: resumedTurnIndex,
    history: [],
    context: options?.context,
    signal: options?.signal,
  });

  const status = result.error
    ? hooks.deriveStatus(result.report.status)
    : "awaiting-input";

  if (result.error) {
    const report = hooks.buildReport(
      resumedTurnIndex,
      status,
      turnSnapshot,
      result.report,
    );

    hooks.emitTerminal(resumedTurnIndex, status);

    return {
      data: result.data,
      error: result.error,
      usage: result.usage,
      report,
      sessionId,
      turnIndex: resumedTurnIndex,
    };
  }

  // Finalize: persist a fresh checkpoint for the resumed turn (§9.1 step 4).
  await hooks.persist(
    resumedTurnIndex,
    state,
    summarizeRoute(turnSnapshot.decision.raw as never),
    loaded.record?.summarized_through ?? null,
  );

  const report = hooks.buildReport(
    resumedTurnIndex,
    "awaiting-input",
    turnSnapshot,
    result.report,
  );

  hooks.emitTerminal(resumedTurnIndex, "awaiting-input");

  return {
    data: result.data,
    error: undefined,
    usage: result.usage,
    report,
    sessionId,
    turnIndex: resumedTurnIndex,
  };
}
