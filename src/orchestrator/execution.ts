import type { Message } from "../contracts/conversation-message.type";
import type { OrchestratorCommands } from "../contracts/orchestrator/orchestrator-commands.type";
import type { OrchestratorConfig } from "../contracts/orchestrator/orchestrator-config.type";
import type {
  OrchestratorEvent,
  OrchestratorEventHandlers,
  OrchestratorEventMap,
  OrchestratorEventName,
} from "../contracts/orchestrator/orchestrator-event.type";
import type {
  OrchestratorExecuteOptions,
  OrchestratorResumeOptions,
} from "../contracts/orchestrator/orchestrator-execute-options.type";
import type {
  CompactionResult,
  OrchestratorReport,
  OrchestratorReportStatus,
  OrchestratorResult,
  TurnSnapshot,
} from "../contracts/result/orchestrator-result.type";
import { REPORT_SCHEMA_VERSION } from "../contracts/result/base-report.type";
import type { BaseReport } from "../contracts/result/base-report.type";
import type { Usage } from "../contracts/result/usage.type";
import type { SupervisorInput } from "../contracts/supervisor/supervisor-input.type";
import type { EventIdentity } from "../contracts/events/event-identity.type";
import {
  resolveDefaultCheckpointStore,
  resolveDefaultSnapshotStore,
} from "../config";
import type { AIError } from "../errors/ai-error";
import { OrchestratorConfigError, OrchestratorDriftError } from "../errors";
import { notifyObservers } from "../observe/resolve-observers";
import type { ResolvedIntentEntry } from "../supervisor/entries";
import { generateRunId } from "../utils/generate-run-id";
import { persistCheckpoint, summarizeRoute } from "./checkpoint";
import { runCompaction, runManualCompaction, shouldCompact } from "./compaction";
import { deriveRunId, dispatchTurn } from "./dispatch";
import type { OrchestratorEmitter } from "./emitter";
import type { OrchestratorEmitterLike } from "./emitter-port.type";
import type { OrchestratorEngineContext } from "./engine-context.type";
import { acquireLock } from "./lock";
import { loadSession } from "./load";
import {
  injectMemories,
  outcomeTextFromTurn,
  recallForTurn,
  rememberTurnOutcome,
  resolveOrchestratorMemory,
} from "./memory";
import type { OrchestratorStreamController } from "./orchestrator-stream";
import { resolveResume } from "./resume";
import { windowHistory } from "./window";

/** Empty rolled-up usage for turns that never dispatched (drift/seed). */
const ZERO_USAGE: Usage = { input: 0, output: 0, total: 0 };

/**
 * Constructor params the C1 factory passes when building an
 * {@link OrchestratorExecution} per call. The factory owns author-time
 * validation, intent-entry resolution, and signature computation; it
 * hands the engine the validated `config`, the resolved `entries`, the
 * computed `signature`, and the shared three-tier `emitter`. The
 * per-call inputs vary by entry point:
 *
 * - `execute` / `stream` — `input` + `options` (and `streamController`
 *   for `stream`).
 * - `resume` — `resumeSessionId` + `resumeOptions`.
 * - `command("compact")` — neither; `compact(args)` carries its own.
 */
export type OrchestratorExecutionParams<TOutput, TState> = {
  config: OrchestratorConfig<TOutput, TState>;
  /** Resolved intent entries (validated by C1; the engine delegates dispatch to the supervisor). */
  entries?: Map<string, ResolvedIntentEntry>;
  signature: string;
  emitter: OrchestratorEmitter;
  input?: SupervisorInput;
  options?: OrchestratorExecuteOptions<TState>;
  streamController?: OrchestratorStreamController<OrchestratorResult<TOutput>>;
  resumeSessionId?: string;
  resumeOptions?: OrchestratorResumeOptions;
};

/**
 * Per-call lifecycle engine — the single object the C1 factory
 * constructs and drives. Owns the 7-phase lifecycle (orchestrator.md §3:
 * load → drift → lock → window → dispatch → persist → compaction),
 * resolving the durable stores (own config field → `ai.config` default)
 * and adapting C1's three-tier {@link OrchestratorEmitter} to the
 * {@link OrchestratorEmitterLike} port the phase modules call.
 *
 * The factory creates a fresh instance per `execute` / `stream` /
 * `resume` / `command` call (single-call lifecycle invariant — §18.8);
 * the heavy lifting lives in the standalone phase functions
 * ({@link runTurn} / {@link runResume}) which this class delegates to.
 *
 * @example
 * const execution = new OrchestratorExecution({
 *   config, entries, signature, emitter, input, options,
 * });
 * const result = await execution.run();
 */
export class OrchestratorExecution<TOutput, TState> {
  private readonly params: OrchestratorExecutionParams<TOutput, TState>;
  private readonly ctx: OrchestratorEngineContext<TOutput, TState>;
  private readonly streamController?: OrchestratorStreamController<
    OrchestratorResult<TOutput>
  >;

  public constructor(params: OrchestratorExecutionParams<TOutput, TState>) {
    this.params = params;
    this.streamController = params.streamController;
    this.ctx = {
      config: params.config,
      signature: params.signature,
      checkpointStore: resolveCheckpointStore(params.config),
      snapshotStore: resolveSnapshotStore(params.config),
      emitter: adaptEmitter(
        params.emitter,
        generateRunId("orchestrator"),
        this.streamController as
          | OrchestratorStreamController<unknown>
          | undefined,
      ),
      memory: resolveOrchestratorMemory(params.config.memory),
    };
  }

  /**
   * `execute()` / `stream()` entry — run one turn through the 7-phase
   * lifecycle. When a `streamController` was supplied, the adapter mirrors
   * every emitted event into the stream and the controller is settled
   * (`end` / `fail`) once the result resolves.
   */
  public async run(): Promise<OrchestratorResult<TOutput>> {
    if (this.params.input === undefined || !this.params.options) {
      throw new OrchestratorConfigError(
        `ai.orchestrator("${this.params.config.name}"): internal — run() invoked without input/options`,
      );
    }

    try {
      const result = await runTurn(
        this.ctx,
        this.params.input,
        this.params.options,
      );

      // Route the orchestrator's report to observers (per-flow `observe` +
      // the global observe-all gate) — parity with agent/workflow/supervisor,
      // so a durable session root no longer needs a manual observe.collect().
      await notifyObservers(this.ctx.config.observe, result.report);

      this.streamController?.end(result);

      return result;
    } catch (error) {
      this.streamController?.fail(error as Error);

      throw error;
    }
  }

  /**
   * `resume()` entry — drain an interrupted `iterate: true` turn (§9).
   * Returns `null` when nothing is in flight.
   */
  public async resume(): Promise<OrchestratorResult<TOutput> | null> {
    if (!this.params.resumeSessionId) {
      throw new OrchestratorConfigError(
        `ai.orchestrator("${this.params.config.name}"): internal — resume() invoked without a sessionId`,
      );
    }

    return runResume(this.ctx, this.params.resumeSessionId, this.params.resumeOptions);
  }

  /**
   * `command("compact")` entry — run a manual compaction on demand (§11 /
   * §12.1). Reuses the post-turn compaction code path against the
   * caller-supplied history and returns the raw {@link CompactionResult}.
   */
  public async compact(
    args: OrchestratorCommands["compact"]["args"],
  ): Promise<OrchestratorCommands["compact"]["result"]> {
    return runManualCompaction(
      this.ctx as OrchestratorEngineContext<unknown, TState>,
      args.history,
    );
  }
}

/**
 * Resolve the durable checkpoint store: the config's own field, falling
 * back to `ai.config({ defaultCheckpointStore })`. Throws
 * {@link OrchestratorConfigError} when neither resolves — persistence is
 * always on (§8.1), so a turn can never run without a checkpoint store.
 */
function resolveCheckpointStore<TOutput, TState>(
  config: OrchestratorConfig<TOutput, TState>,
) {
  const store = config.checkpointStore ?? resolveDefaultCheckpointStore();

  if (!store) {
    throw new OrchestratorConfigError(
      `ai.orchestrator("${config.name}"): a \`checkpointStore\` is required ` +
        `(set one on the config or via \`ai.config({ defaultCheckpointStore })\`)`,
    );
  }

  return store;
}

/**
 * Resolve the internal-supervisor snapshot store for `iterate: true`
 * turns: the config's own field, falling back to
 * `ai.config({ defaultSnapshotStore })`. Returns `undefined` for
 * `iterate: false` orchestrators (no mid-turn resume — nothing to
 * snapshot). The factory already guarantees presence when
 * `iterate: true`, so the engine never asserts here.
 */
function resolveSnapshotStore<TOutput, TState>(
  config: OrchestratorConfig<TOutput, TState>,
) {
  if (config.iterate !== true) {
    return undefined;
  }

  return config.snapshotStore ?? resolveDefaultSnapshotStore();
}

/**
 * Adapt C1's three-tier {@link OrchestratorEmitter} (whose `emit` takes
 * `event, payload, identity, perCallHandlers?`) to the
 * {@link OrchestratorEmitterLike} port the phase modules call (a 2-arg
 * `emit(event, payload)` plus `bindPerCall`).
 *
 * The adapter injects the run identity centrally and, when a stream
 * controller is present, mirrors every fully-stamped event into the
 * stream pipe (§14.1 — the orchestrator's own events surface on the
 * stream alongside the bubbled child events). `bindPerCall` registers
 * the per-call `options.on` bag for the turn's duration and returns a
 * disposer that clears it.
 */
function adaptEmitter(
  emitter: OrchestratorEmitter,
  runId: string,
  streamController: OrchestratorStreamController<unknown> | undefined,
): OrchestratorEmitterLike {
  // `rootRunId === runId` for a standalone run; nested propagation lands
  // in a follow-up (see `EventIdentity`).
  const fullIdentity: EventIdentity = { runId, rootRunId: runId };

  let perCall: OrchestratorEventHandlers | undefined;

  return {
    emit<K extends OrchestratorEventName>(
      event: K,
      payload: OrchestratorEventMap[K],
    ): void {
      const fullPayload = emitter.emit(event, payload, fullIdentity, perCall);

      // The discriminated-union correlation between `type` and the
      // matching payload variant can't be expressed structurally — the
      // cast mirrors the supervisor stream's established pattern.
      streamController?.push({ type: event, ...fullPayload } as OrchestratorEvent);
    },
    bindPerCall(handlers: OrchestratorEventHandlers | undefined): () => void {
      perCall = handlers;

      return () => {
        perCall = undefined;
      };
    },
  };
}

/**
 * Phase 2 — drift check (orchestrator.md §3 / §4 Phase 2). Compares the
 * loaded checkpoint's `signature` against the current definition's.
 * Mismatch throws `OrchestratorDriftError` synchronously unless
 * `force` is set. Emits `orchestrator.drift.checked` either way. A new
 * session (no loaded signature) never drifts.
 */
function assertNoDrift(
  ctx: OrchestratorEngineContext,
  sessionId: string,
  loadedSignature: string | undefined,
  force: boolean | undefined,
): void {
  const drifted =
    loadedSignature !== undefined && loadedSignature !== ctx.signature;

  ctx.emitter.emit("orchestrator.drift.checked", {
    sessionId,
    signature: ctx.signature,
    drifted,
  });

  if (drifted && !force) {
    throw new OrchestratorDriftError(
      `orchestrator "${ctx.config.name}": signature drift on session "${sessionId}" — ` +
        `the definition changed since this session was last persisted. ` +
        `Pass { force: true } only after reviewing the change, or discard / migrate the session.`,
      {
        savedSignature: loadedSignature as string,
        currentSignature: ctx.signature,
        sessionId,
      },
    );
  }
}

/**
 * Shallow-merge the per-call `state` patch (§5 — partial state
 * override) over the loaded session-state seed. The merged value
 * becomes the supervisor's seed for this turn.
 */
function applyStatePatch<TState>(
  seed: TState,
  patch: Partial<TState> | undefined,
): TState {
  if (!patch) {
    return seed;
  }

  return { ...seed, ...patch } as TState;
}

/**
 * Assemble the orchestrator-scope {@link OrchestratorReport} from the
 * dispatched turn's child report and the turn snapshot. Wraps the
 * child supervisor/agent report tree as `children[0]` (§15.6 —
 * `children[]` carries only the CURRENT turn's dispatched primitive
 * reports) while the per-turn forensic record lives on `turns[]`.
 */
function buildReport(
  ctx: OrchestratorEngineContext,
  sessionId: string,
  turnIndex: number,
  status: OrchestratorReportStatus,
  turnSnapshot: TurnSnapshot | undefined,
  childReport: BaseReport | undefined,
  error?: AIError,
): OrchestratorReport {
  const now = new Date().toISOString();
  const usage = turnSnapshot?.usage ?? childReport?.usage ?? ZERO_USAGE;

  return {
    runId: deriveRunId(sessionId, ctx.config.version, turnIndex),
    rootRunId: deriveRunId(sessionId, ctx.config.version, turnIndex),
    name: ctx.config.name,
    version: ctx.config.version,
    sessionId,
    type: "orchestrator",
    status,
    // Stamp the terminal error so the observe path surfaces it on the
    // orchestrator span (an observer never sees the result envelope).
    // Absent on a clean turn.
    ...(error ? { error } : {}),
    startedAt: turnSnapshot?.startedAt ?? now,
    endedAt: turnSnapshot?.endedAt ?? now,
    duration: turnSnapshot?.duration ?? 0,
    usage,
    children: childReport ? [childReport] : [],
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    turnIndex,
    signature: ctx.signature,
    turns: turnSnapshot ? [turnSnapshot] : [],
  };
}

/**
 * Map the dispatched supervisor result's report status onto the
 * orchestrator's status surface (§15.6). A clean completion that is
 * still mid-conversation reports `"awaiting-input"` (the session
 * continues) rather than `"completed"`; failures and cancellations
 * pass through.
 */
function deriveStatus(childStatus: BaseReport["status"]): OrchestratorReportStatus {
  if (childStatus === "completed") {
    return "awaiting-input";
  }

  return childStatus;
}

/**
 * Emit the terminal turn event matching the report status (§14.1).
 */
function emitTerminal(
  ctx: OrchestratorEngineContext,
  sessionId: string,
  turnIndex: number,
  status: OrchestratorReportStatus,
): void {
  if (status === "cancelled") {
    ctx.emitter.emit("orchestrator.turn.cancelled", { sessionId, turnIndex });

    return;
  }

  if (status === "failed" || status === "max-iterations") {
    ctx.emitter.emit("orchestrator.turn.failed", { sessionId, turnIndex });

    return;
  }

  if (status === "awaiting-input") {
    ctx.emitter.emit("orchestrator.turn.awaiting-input", {
      sessionId,
      turnIndex,
    });

    return;
  }

  ctx.emitter.emit("orchestrator.turn.completed", { sessionId, turnIndex });
}

/**
 * Run one turn end-to-end through the 7-phase lifecycle (orchestrator
 * .md §3). The single entry the C1 factory's `execute()` delegates to.
 *
 * Phase order is the diagram's contract: load → drift → lock → window
 * → dispatch → persist → compaction. Drift / config misuse throw;
 * every other failure surfaces on `result.error` (the contract: the
 * orchestrator never throws on runtime failure). Cancellation and
 * failure do NOT persist a fresh checkpoint (§17 — state reverts to the
 * pre-turn checkpoint).
 */
export async function runTurn<TOutput, TState>(
  ctx: OrchestratorEngineContext<TOutput, TState>,
  input: SupervisorInput,
  options: OrchestratorExecuteOptions<TState>,
): Promise<OrchestratorResult<TOutput>> {
  const sessionId = options.sessionId;
  const disposePerCall = ctx.emitter.bindPerCall(options.on);

  try {
    // Phase 1 — load session.
    const loaded = await loadSession(ctx, sessionId);

    ctx.emitter.emit("orchestrator.turn.starting", {
      sessionId,
      turnIndex: loaded.turnIndex,
    });

    ctx.emitter.emit("orchestrator.session.loaded", {
      sessionId,
      turnIndex: loaded.turnIndex,
      found: loaded.found,
    });

    // Phase 2 — drift check.
    assertNoDrift(
      ctx as OrchestratorEngineContext,
      sessionId,
      loaded.record?.signature,
      options.force,
    );

    // Phase 3 — lock check (cooperative, fail-open).
    await acquireLock(ctx, sessionId, loaded.record);

    // Phase 4 — window history.
    const windowed = windowHistory(
      ctx as OrchestratorEngineContext,
      sessionId,
      options.history,
    );

    // Phase 5 — dispatch. When memory is configured, recall the
    // turn-relevant memories and inject them into the request-scoped
    // context bag so every route / router / evaluate / dispatch callback
    // surfaces them at `ctx.context[injectKey]` before routing runs.
    const seedState = applyStatePatch(loaded.state, options.state);

    let turnContext = options.context;

    if (ctx.memory) {
      const recalled = await recallForTurn(ctx.memory, input);
      turnContext = injectMemories(turnContext, ctx.memory, recalled);
    }

    const { result, state, turnSnapshot } = await dispatchTurn<TOutput, TState>({
      ctx,
      sessionId,
      input,
      seedState,
      turnIndex: loaded.turnIndex,
      history: windowed.agents,
      context: turnContext,
      signal: options.signal,
    });

    ctx.emitter.emit("orchestrator.turn.routed", {
      sessionId,
      turnIndex: loaded.turnIndex,
      source: turnSnapshot.decision.source,
      raw: turnSnapshot.decision.raw,
    });

    const status = result.error
      ? deriveStatus(result.report.status)
      : "awaiting-input";

    // Cancelled / failed turns revert: no fresh checkpoint, no compaction.
    if (result.error) {
      const report = buildReport(
        ctx as OrchestratorEngineContext,
        sessionId,
        loaded.turnIndex,
        status,
        turnSnapshot,
        result.report,
        result.error,
      );

      emitTerminal(ctx as OrchestratorEngineContext, sessionId, loaded.turnIndex, status);

      return {
        data: result.data,
        error: result.error,
        usage: result.usage,
        report,
        sessionId,
        turnIndex: loaded.turnIndex,
      };
    }

    // Phase 6 — persist checkpoint.
    await persistCheckpoint({
      ctx,
      sessionId,
      turnIndex: loaded.turnIndex,
      state,
      lastRoute: summarizeRoute(turnSnapshot.decision.raw as never),
      summarizedThrough: loaded.record?.summarized_through ?? null,
    });

    // Memory write-back (memory core M2). The turn settled cleanly (the
    // `result.error` branch above already returned for cancelled /
    // failed turns, which revert and never remember — §17), so remember
    // the input + its outcome for later recall.
    if (ctx.memory) {
      await rememberTurnOutcome(
        ctx.memory,
        input,
        outcomeTextFromTurn(result.data, turnSnapshot),
      );
    }

    // Phase 7 — post-turn compaction (only when triggered).
    let compaction: CompactionResult | undefined;

    if (shouldCompact(ctx as OrchestratorEngineContext, loaded.turnIndex)) {
      const outcome = await runCompaction(
        ctx as OrchestratorEngineContext<unknown, TState>,
        sessionId,
        options.history,
      );

      if (outcome) {
        compaction = outcome.compaction;

        if (outcome.applied) {
          await advanceSummarizedThrough(
            ctx as OrchestratorEngineContext<unknown, TState>,
            sessionId,
            outcome.compaction.replacesToIndex,
          );
        }
      }
    }

    const report = buildReport(
      ctx as OrchestratorEngineContext,
      sessionId,
      loaded.turnIndex,
      "awaiting-input",
      turnSnapshot,
      result.report,
    );

    emitTerminal(ctx as OrchestratorEngineContext, sessionId, loaded.turnIndex, "awaiting-input");

    return {
      data: result.data,
      error: undefined,
      usage: result.usage,
      report,
      sessionId,
      turnIndex: loaded.turnIndex,
      compaction,
    };
  } finally {
    disposePerCall();
  }
}

/**
 * After a framework-applied compaction (`onCompact` succeeded), advance
 * the persisted `summarized_through` to the compaction's
 * `replacesToIndex` (§12.2 step 4). Re-saves the latest row with the
 * updated marker (append-only stores keep the prior row).
 */
async function advanceSummarizedThrough<TState>(
  ctx: OrchestratorEngineContext<unknown, TState>,
  sessionId: string,
  replacesToIndex: number,
): Promise<void> {
  const latest = await ctx.checkpointStore.load(ctx.config.name, sessionId);

  if (!latest) {
    return;
  }

  await ctx.checkpointStore.save({
    ...latest,
    summarized_through: replacesToIndex,
    saved_at: new Date().toISOString(),
  });
}

/**
 * §9 resume protocol entry the C1 factory's `resume()` delegates to.
 * Returns `null` when no in-flight `iterate: true` turn is detected;
 * otherwise drains the interrupted supervisor run, persists a fresh
 * checkpoint for the resumed turn, and returns the completed result.
 *
 * Runs the same Phase 2 drift check as `runTurn` (§9.4). The heavy
 * lifting lives in `resume.ts`; this wrapper threads the engine
 * context.
 */
export async function runResume<TOutput, TState>(
  ctx: OrchestratorEngineContext<TOutput, TState>,
  sessionId: string,
  options?: OrchestratorResumeOptions,
): Promise<OrchestratorResult<TOutput> | null> {
  const disposePerCall = ctx.emitter.bindPerCall(options?.on);

  try {
    return await resolveResume(ctx, sessionId, options, {
      assertNoDrift: (loadedSignature) =>
        assertNoDrift(
          ctx as OrchestratorEngineContext,
          sessionId,
          loadedSignature,
          options?.force,
        ),
      buildReport: (turnIndex, status, turnSnapshot, childReport) =>
        buildReport(
          ctx as OrchestratorEngineContext,
          sessionId,
          turnIndex,
          status,
          turnSnapshot,
          childReport,
        ),
      deriveStatus,
      emitTerminal: (turnIndex, status) =>
        emitTerminal(ctx as OrchestratorEngineContext, sessionId, turnIndex, status),
      persist: (turnIndex, state, lastRoute, summarizedThrough) =>
        persistCheckpoint({
          ctx,
          sessionId,
          turnIndex,
          state,
          lastRoute,
          summarizedThrough,
        }),
    });
  } finally {
    disposePerCall();
  }
}

/**
 * The `stream()` entry. The orchestrator's streaming surface bubbles
 * child agent/supervisor events under their own namespace (§14.2); the
 * C1 stream controller owns the `StreamContract` wiring. This engine
 * entry runs the same lifecycle as `runTurn` — the C1 factory passes a
 * per-call `on` bag wired to the stream controller, so the engine needs
 * no streaming-specific branch. Exposed as a distinct name for the
 * factory to call, returning the same `OrchestratorResult` the stream's
 * `.result` resolves to.
 */
export async function streamTurn<TOutput, TState>(
  ctx: OrchestratorEngineContext<TOutput, TState>,
  input: SupervisorInput,
  options: OrchestratorExecuteOptions<TState>,
): Promise<OrchestratorResult<TOutput>> {
  return runTurn(ctx, input, options);
}

export type { OrchestratorEngineContext } from "./engine-context.type";
export type { Message };
