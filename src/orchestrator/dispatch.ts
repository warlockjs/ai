import type { Message } from "../contracts/conversation-message.type";
import type { SnapshotStore } from "../contracts/orchestrator/snapshot-store.contract";
import type { SupervisorResult } from "../contracts/result/supervisor-result.type";
import type { TurnSnapshot } from "../contracts/result/orchestrator-result.type";
import type { SupervisorConfig } from "../contracts/supervisor/supervisor-config.type";
import type { SupervisorInput } from "../contracts/supervisor/supervisor-input.type";
import type { SupervisorReport } from "../contracts/result/supervisor-result.type";
import type { OrchestratorEngineContext } from "./engine-context.type";
import { supervisor as createSupervisor } from "../supervisor/supervisor";

/**
 * Derive the deterministic supervisor `runId` for an `iterate: true`
 * turn (orchestrator.md §5 Phase 5 / §10.2 / §18.7):
 * `${sessionId}.${version ?? "unversioned"}.${turnIndex}`. No base64,
 * no hashing — the `sessionId` is the dev's responsibility to make
 * unique. Deploying a new `version` cleanly partitions in-flight runs
 * across deploys so old runIds never collide with new ones.
 */
export function deriveRunId(
  sessionId: string,
  version: string | undefined,
  turnIndex: number,
): string {
  return `${sessionId}.${version ?? "unversioned"}.${turnIndex}`;
}

/** Parameters for one Phase-5 dispatch. */
export type DispatchParams<TOutput, TState> = {
  ctx: OrchestratorEngineContext<TOutput, TState>;
  sessionId: string;
  input: SupervisorInput;
  /** The session-state seed assembled in Phase 1 + the per-call patch. */
  seedState: TState;
  turnIndex: number;
  /** Agent-windowed history from Phase 4. */
  history: Message[];
  context?: Record<string, unknown>;
  signal?: AbortSignal;
};

/** Outcome of Phase 5 — the supervisor result plus the turn's snapshot. */
export type DispatchOutcome<TOutput> = {
  result: SupervisorResult<TOutput>;
  /** Post-dispatch session state (replaces session state per §5). */
  state: unknown;
  turnSnapshot: TurnSnapshot;
};

/**
 * Build the internal supervisor config by spreading the orchestrator's
 * supervisor-surface fields (orchestrator.md §1 / §5 Phase 5) and
 * seeding `state` from the session-state seed.
 *
 * `iterate: false` caps `maxIterations` at 1 — a single dispatch per
 * turn ("the supervisor's Phase A + Phase B once, no iteration loop" —
 * §5). `iterate: true` keeps the configured `maxIterations` (default
 * 10) and wires the `snapshotStore` for mid-turn resume.
 *
 * The orchestrator DELEGATES to the existing supervisor — it never
 * reimplements dispatch / route / evaluate / strip-merge logic.
 */
function buildSupervisorConfig<TOutput, TState>(
  ctx: OrchestratorEngineContext<TOutput, TState>,
  seedState: TState,
  iterate: boolean,
  snapshotStore: SnapshotStore | undefined,
): SupervisorConfig<TOutput, TState> {
  const config = ctx.config;

  const supervisorConfig: SupervisorConfig<TOutput, TState> = {
    name: config.name,
    version: config.version,
    systemPrompt: config.systemPrompt,
    intents: config.intents,
    route: config.route,
    router: config.router,
    evaluate: config.evaluate,
    state: seedState,
    output: config.output,
    initialAgent: config.initialAgent,
    maxIterations: iterate ? config.maxIterations : 1,
    historyWindow: config.historyWindow
      ? { router: toNumber(config.historyWindow.router), agents: toNumber(config.historyWindow.agents) }
      : undefined,
    snapshotStore: iterate ? snapshotStore : undefined,
  };

  return supervisorConfig;
}

/**
 * The supervisor's `historyWindow` tiers accept only numbers; the
 * orchestrator's accept a number OR a slicer callback. The callback
 * form is already applied at the orchestrator level (Phase 4), so any
 * non-number here has already done its slicing — drop it for the
 * supervisor (which sees the pre-sliced history) by returning
 * `undefined`.
 */
function toNumber(
  value: number | ((messages: Message[]) => Message[]) | undefined,
): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * Build the forensic {@link TurnSnapshot} for the dispatched turn from
 * the supervisor's result. Mirrors the supervisor's `IterationSnapshot`
 * shape (§15.5) so a turn reads uniformly whether one agent ran
 * (`iterate: false`) or the internal supervisor iterated
 * (`iterate: true`). The terminal iteration's branch records and
 * decision are lifted onto the turn; the supervisor's full report tree
 * becomes the turn's `childReport`.
 */
function buildTurnSnapshot(
  input: SupervisorInput,
  turnIndex: number,
  result: SupervisorResult<unknown>,
  state: unknown,
): TurnSnapshot {
  const report = result.report;
  const snapshots = report.snapshots;
  const terminal = snapshots.length > 0 ? snapshots[snapshots.length - 1] : undefined;

  const decisionSource = mapDecisionSource(terminal?.decision.source);

  return Object.freeze({
    turn: turnIndex,
    input,
    decision: {
      source: decisionSource,
      raw: terminal?.decision.next ?? null,
      reasoning: terminal?.decision.reasoning,
    },
    result: terminal?.result ?? {},
    state,
    evaluate: terminal?.evaluateVerdict,
    startedAt: report.startedAt,
    endedAt: report.endedAt,
    duration: report.duration,
    usage: report.usage,
    childReport: report,
  });
}

/**
 * Map the supervisor's `DecisionSource` onto the narrower turn-snapshot
 * decision source (§15.5 — `"route" | "router" | "intent.next"`). The
 * supervisor's `initialAgent` / `classifier` first-turn sources collapse
 * to `"intent.next"` (a non-route/router origin) at the orchestrator
 * layer, which only distinguishes the three coarse decision origins.
 */
function mapDecisionSource(
  source: "route" | "router" | "initialAgent" | "classifier" | undefined,
): "route" | "router" | "intent.next" {
  if (source === "route" || source === "router") {
    return source;
  }

  return "intent.next";
}

/**
 * Phase 5 — dispatch turn (orchestrator.md §3 / §4 Phase 5).
 *
 * Constructs a fresh internal supervisor seeded from the session state,
 * then:
 *
 * - `iterate: false` — runs a single dispatch (`maxIterations: 1`).
 * - `iterate: true` — runs the full supervisor with a deterministic
 *   `runId`, resuming an in-flight run when the `SnapshotStore` already
 *   has one for that `runId` (§5 step 5).
 *
 * The supervisor's final state replaces the session state (§5 — replace
 * semantics). The supervisor is never kept alive across turns
 * (single-call lifecycle invariant — §18.8).
 */
export async function dispatchTurn<TOutput, TState>(
  params: DispatchParams<TOutput, TState>,
): Promise<DispatchOutcome<TOutput>> {
  const { ctx, sessionId, input, seedState, turnIndex, history, context, signal } =
    params;

  const iterate = ctx.config.iterate === true;
  const sup = createSupervisor<TOutput, TState>(
    buildSupervisorConfig(ctx, seedState, iterate, ctx.snapshotStore),
  );

  let result: SupervisorResult<TOutput>;

  if (iterate) {
    const runId = deriveRunId(sessionId, ctx.config.version, turnIndex);
    const inFlight = ctx.snapshotStore
      ? await ctx.snapshotStore.load(runId)
      : undefined;

    if (inFlight && inFlight.status === "running") {
      result = await sup.resume(runId, { context, signal, history, sessionId });
    } else {
      result = await sup.execute(input, { runId, context, signal, history, sessionId });
    }
  } else {
    result = await sup.execute(input, { context, signal, history, sessionId });
  }

  const state = deriveFinalState(result, seedState);
  const turnSnapshot = buildTurnSnapshot(input, turnIndex, result, state);

  return { result, state, turnSnapshot };
}

/**
 * Derive the post-turn session state from the supervisor result.
 * Prefers the terminal iteration's accumulated `state`; falls back to
 * the validated `data` (when an `output` schema reshaped it), then to
 * the seed when the run produced neither (e.g. it terminated before
 * dispatching anything). Replace semantics — the supervisor is the
 * authority on state evolution within its loop (§5).
 */
function deriveFinalState<TOutput, TState>(
  result: SupervisorResult<TOutput>,
  seedState: TState,
): unknown {
  const report: SupervisorReport = result.report;
  const snapshots = report.snapshots;
  const terminal = snapshots.length > 0 ? snapshots[snapshots.length - 1] : undefined;

  if (terminal && terminal.state !== undefined) {
    return terminal.state;
  }

  if (result.data !== undefined) {
    return result.data;
  }

  return seedState;
}
