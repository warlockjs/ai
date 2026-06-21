import type { StandardSchemaV1 } from "@standard-schema/spec";
import { log, type Logger } from "@warlock.js/logger";
import type { AgentContract } from "../contracts/agent/agent.contract";
import type { Message } from "../contracts/conversation-message.type";
import { END } from "../contracts/end.type";
import type { EventIdentity, WithoutIdentity } from "../contracts/events/event-identity.type";
import type { SupervisorEventMap } from "../contracts/events/event-map.type";
import type { AgentResult } from "../contracts/result/agent-result.type";
import type { BaseReport } from "../contracts/result/base-report.type";
import type {
  SupervisorReport,
  SupervisorResult,
  SupervisorTerminatedBy,
} from "../contracts/result/supervisor-result.type";
import type { Usage } from "../contracts/result/usage.type";
import type { WorkflowResult } from "../contracts/result/workflow-result.type";
import type { StreamContract } from "../contracts/stream/stream.contract";
import type {
  ClassifierConfig,
  ClassifierContext,
  ClassifierOutput,
  ClassifierRefineContext,
  ClassifierRefineResult,
  ClassifierSnapshot,
} from "../contracts/supervisor/classifier-context.type";
import type {
  DispatchContext,
  StreamableExecutable,
  SupervisableExecutable,
  SupervisableExecuteOptions,
  SupervisableResult,
} from "../contracts/supervisor/dispatch-context.type";
import type {
  EvaluateBranchResult,
  EvaluateContext,
  EvaluateResult,
} from "../contracts/supervisor/evaluate-context.type";
import type {
  AckSnapshot,
  AgentBranchSnapshot,
  IterationSnapshot,
} from "../contracts/supervisor/iteration-snapshot.type";
import type { RouteContext } from "../contracts/supervisor/route-context.type";
import type { SupervisorConfig } from "../contracts/supervisor/supervisor-config.type";
import type { SupervisorExecuteOptions } from "../contracts/supervisor/supervisor-execute-options.type";
import type { SupervisorInput } from "../contracts/supervisor/supervisor-input.type";
import type {
  SupervisorSnapshot,
  SupervisorSnapshotStatus,
} from "../contracts/supervisor/supervisor-snapshot.type";
import type { WorkflowInstance } from "../contracts/workflow/workflow.contract";
import {
  AIError,
  MaxIterationsError,
  SchemaValidationError,
  SupervisorCancelledError,
  SupervisorFailedError,
} from "../errors";
import { stampReportLineage } from "../utils";
import type { AgentMiddleware } from "../contracts/middleware/middleware.contract";
import type { MiddlewareSupervisorContext } from "../contracts/middleware/middleware-context.type";
import type { MiddlewareState } from "../contracts/middleware/middleware-state.type";
import { runPipeline } from "../middleware/pipeline";
import { createCancelledError } from "./cancellation";
import { decide, type DispatchDecision } from "./decide";
import type { SupervisorEmitter } from "./emitter";
import type { ResolvedCallbackEntry, ResolvedIntentEntry } from "./entries";
import { isAgentResult, isWorkflowResult } from "./entries";
import { persistSupervisorSnapshot } from "./snapshot";
import type { SupervisorStreamController, SupervisorStreamEvent } from "./supervisor-stream";

const DEFAULT_MAX_ITERATIONS = 10;
const LOG_MODULE_BASE = "ai.supervisor";

export type SupervisorExecutionParams<TOutput> = {
  config: SupervisorConfig<TOutput>;
  entries: Map<string, ResolvedIntentEntry>;
  signature: string;
  emitter: SupervisorEmitter;
  input: SupervisorInput;
  runId: string;
  options?: SupervisorExecuteOptions;
  streamController?: SupervisorStreamController<SupervisorResult<TOutput>>;
  resumeFrom?: SupervisorSnapshot;
};

/**
 * Per-call driver that owns the full lifecycle of one supervisor run.
 *
 * **Role.** Short-lived state container and phase orchestrator —
 * mirrors `agent/Execution` and `workflow/runWorkflow`, one level up.
 *
 * **Responsibility.**
 * - Owns: the iteration loop, per-iteration dispatch (single or
 *   fan-out), evaluate scheduling, usage aggregation across router +
 *   every branch + evaluate, snapshot collection, event emission
 *   through all three tiers, KV-store checkpointing, final result
 *   assembly (state validation against the output schema → typed data).
 * - Does NOT own: how child agents produce responses (delegated via
 *   `agent.execute` / `workflow.execute`), the routing decision
 *   itself (delegated to `decide.ts`), snapshot persistence mechanics
 *   (delegated to `snapshot.ts`), the stream queue plumbing
 *   (delegated to `supervisor-stream.ts`).
 *
 * `execute()` never throws — every unexpected failure funnels into
 * `this.error` and is returned on `result.error` with an appropriate
 * `SupervisorFailedError` / `MaxIterationsError` / `SupervisorRoutingError`
 * / `SupervisorCancelledError`.
 *
 * @example
 * // Inside supervisor.execute() — never constructed by user code directly:
 * return new SupervisorExecution(params).run();
 */
export class SupervisorExecution<TOutput> {
  private readonly config: SupervisorConfig<TOutput>;
  private readonly entries: Map<string, ResolvedIntentEntry>;
  private readonly signature: string;
  private readonly emitter: SupervisorEmitter;
  private readonly input: SupervisorInput;
  private readonly runId: string;
  private readonly options?: SupervisorExecuteOptions;
  private readonly streamController?: SupervisorStreamController<SupervisorResult<TOutput>>;
  private readonly resumeFrom?: SupervisorSnapshot;

  private readonly maxIterations: number;
  private readonly logger: Logger = log;
  private readonly logModule: string;

  /**
   * Supervisor-level middleware stack — `config.middleware` (default
   * empty). Each entry's optional `supervisor` hook map fires once
   * around the whole run via `runPipeline(..., "supervisor", ...)` in
   * {@link run}; entries without that hook map are skipped by the
   * pipeline.
   */
  private readonly middleware: ReadonlyArray<AgentMiddleware>;
  /**
   * Per-run shared-state bag threaded through every `supervisor`-level
   * hook (`before` / `after` / `onError`) of this one run. Fresh `Map`
   * per `SupervisorExecution` so two concurrent runs of the same
   * supervisor get isolated bags — mirrors the agent pipeline.
   */
  private readonly middlewareState: MiddlewareState = new Map();

  private readonly snapshots: IterationSnapshot[] = [];
  private readonly childReports: BaseReport[] = [];
  private readonly usage: Usage = { input: 0, output: 0, total: 0 };

  private readonly startedAtIso: string;
  private readonly startPerf = performance.now();

  private iteration = 0;
  private carriedFeedback?: EvaluateResult;
  /**
   * Per-intent `next` directive (Q24 / Stage 4d) collected at the
   * end of an iteration after evaluate hasn't already steered. When
   * set, `decideDispatch` consumes it on the next iteration's start —
   * skipping the router entirely. Cleared after consumption.
   *
   * Only the dispatch variant is stored; an `END` collection
   * terminates the iteration loop directly inside `runIteration`.
   */
  private carriedNextDispatch?: { intents: string[] };
  private terminatedBy: SupervisorTerminatedBy = "error";
  private status: SupervisorReport["status"] = "failed";
  private cancelledAtIso?: string;
  private error?: AIError;
  private data?: TOutput;
  private lastDispatchIntents: string[] = [];
  /**
   * Per-execute typed accumulator. Initialized from `config.state`
   * (default `{}`) at construction; rehydrated from the last
   * snapshot's `state` on resume; mutated in-place as each iteration's
   * intents strip-merge their outputs into it.
   */
  private state: Record<string, unknown> = {};
  /**
   * Per-iteration artifacts bag (Phase 5 / decisions §35). Tools
   * dispatched within an iteration mutate `ctx.artifacts` — which
   * points at this object. After the iteration's branches settle and
   * their slices merge into state, this bag validates against
   * `config.artifactsSchema` (if set) and merges via
   * `config.finalizeArtifacts` or auto-spread, then resets to `{}`
   * for the next iteration. The reset is crucial — long runs and
   * orchestrator sessions never accumulate raw artifacts here.
   */
  private currentArtifacts: Record<string, unknown> = {};
  /**
   * Frozen copy of the iteration's `currentArtifacts` bag captured at
   * merge time — BEFORE `finalizeArtifacts` (or auto-spread) reshaped
   * it into state (Phase 8 / decisions §38). Surfaced on the iteration
   * snapshot's `artifacts` field for forensic / telemetry consumers
   * that want the raw tool contributions.
   *
   * Reset to `{}` at the start of every iteration so a snapshot built
   * for an iteration whose tools wrote nothing carries an empty bag,
   * not a stale carry-over.
   */
  private capturedIterationArtifacts: Readonly<Record<string, unknown>> = Object.freeze({});
  /**
   * Classifier (Phase 7 / decisions §37) forensic record. Set on iter
   * 0 when `SupervisorConfig.classifier` is configured AND the run
   * started fresh (resumes don't re-fire classifier — same as ack).
   * Surfaced on `SupervisorReport.classifier` and threaded into
   * `ctx.classifier` on RouteContext / DispatchContext /
   * EvaluateContext from iter 0 onward.
   */
  private classifierSnapshot?: ClassifierSnapshot;
  /**
   * Iter-0 dispatch decision pre-computed by the classifier (Phase 7).
   * When set, `decideDispatch` short-circuits and uses this directly
   * with `source: "classifier"`. Cleared after consumption.
   */
  private carriedClassifierDispatch?: { intent: string };
  /** Set true by classifier refine returning END to halt before any dispatch. */
  private classifierHalted = false;
  /**
   * Receptionist forensic record. Set when an `ackAgent` was
   * configured AND the run started fresh (resumes don't re-fire ack).
   * Surfaced on `SupervisorReport.ack`.
   */
  private ackSnapshot?: AckSnapshot;
  /**
   * Read-only request-scoped context surfaced on every `ctx.context`.
   * Shallow-copied + frozen at construction so callbacks see a stable
   * snapshot of the caller's bag and can't mutate the original.
   * Always present — defaults to a frozen `{}` when no context was
   * passed. NOT persisted in snapshots.
   */
  private readonly context: Readonly<Record<string, unknown>>;
  /**
   * Prior conversation messages threaded through every callback context
   * (`ctx.history`) and forwarded verbatim to dispatched agents (and the
   * receptionist `ack` agent) as `agent.execute(input, { history })`.
   * Frozen reference so callbacks see a stable view; not deep-cloned —
   * conversation messages are treated as immutable by convention. NOT
   * persisted in snapshots (re-supply on `resume()`).
   */
  private readonly history: ReadonlyArray<Message>;
  /**
   * Resolved natural-language objective from `SupervisorConfig.goal`.
   * Materialized to plain text at construction (string passes through;
   * `SystemPromptContract` is `.resolve()`-d). `undefined` when the
   * supervisor was configured without a goal.
   */
  private readonly goal: string | undefined;

  public constructor(params: SupervisorExecutionParams<TOutput>) {
    this.config = params.config;
    this.entries = params.entries;
    this.signature = params.signature;
    this.emitter = params.emitter;
    this.input = params.input;
    this.runId = params.runId;
    this.options = params.options;
    this.streamController = params.streamController;
    this.resumeFrom = params.resumeFrom;

    this.maxIterations = params.config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.logModule = `${LOG_MODULE_BASE}.${params.config.name}`;
    this.middleware = params.config.middleware ?? [];

    // Shallow-copy + freeze the caller's context. Shallow only —
    // freezing deeply would break valid use cases (mutable DB
    // clients, abort controllers) without delivering meaningful
    // safety beyond what TS `Readonly` already enforces.
    this.context = Object.freeze({ ...(params.options?.context ?? {}) });
    // Freeze the array reference so callbacks can't mutate the slot
    // (`history.push(...)`); messages themselves are passed by reference
    // — supervisors trust the agent layer's read-only convention.
    // Precedence: per-call `options.history` (most explicit) overrides
    // factory-level `config.history` (default for callers who don't
    // supply per-call history). Final fallback is an empty array.
    this.history = Object.freeze([...(params.options?.history ?? params.config.history ?? [])]);

    // Resolve `goal` to plain text once, at construction. `string`
    // passes through; `SystemPromptContract` is `.resolve()`-d (it owns
    // its own placeholder substitution). `undefined` when no goal was
    // configured — every `ctx.goal` consumer must guard for absence.
    if (typeof params.config.goal === "string") {
      this.goal = params.config.goal;
    } else if (params.config.goal) {
      this.goal = params.config.goal.resolve();
    } else {
      this.goal = undefined;
    }

    if (params.resumeFrom) {
      this.snapshots.push(...params.resumeFrom.snapshots);
      this.iteration = params.resumeFrom.iteration + 1;
      this.startedAtIso = params.resumeFrom.startedAt;
      // Resume rehydrates state from the last persisted iteration —
      // every iteration's snapshot carries the post-merge state, so
      // the resume point's state is the last snapshot's state.
      const lastSnapshot = params.resumeFrom.snapshots[params.resumeFrom.snapshots.length - 1];
      this.state = {
        ...(lastSnapshot?.state ??
          (params.config.state as Record<string, unknown> | undefined) ??
          {}),
      };
    } else {
      this.startedAtIso = new Date().toISOString();
      this.state = {
        ...((params.config.state as Record<string, unknown> | undefined) ?? {}),
      };
    }
  }

  /**
   * Resolve the history slice forwarded to a child execution (router /
   * dispatched agent / ack). Precedence:
   *
   *   1. Per-entry `history` callback — full override; whatever it
   *      returns goes through (after defensive copy).
   *   2. `SupervisorConfig.historyWindow.<role>` — last-N slice of the
   *      caller-supplied history.
   *   3. Default — full history for `router`/`agents`, empty for `ack`
   *      (receptionists rarely benefit from scroll-back).
   *
   * Always returns a fresh `Message[]` (the agent layer
   * mutates by reference internally, e.g. via `messages.push(...)`).
   */
  private resolveHistoryFor(
    role: "router" | "agents" | "ack",
    routeContext: RouteContext,
    entrySlicer?: (ctx: RouteContext) => Message[] | ReadonlyArray<Message>,
  ): Message[] {
    if (entrySlicer) {
      const sliced = entrySlicer(routeContext);
      return sliced ? [...sliced] : [];
    }

    const window = this.config.historyWindow?.[role];

    if (role === "ack") {
      // Default for ack is empty — receptionists rarely need history.
      // Override is opt-in via `historyWindow.ack: N`.
      if (window === undefined || window <= 0) {
        return [];
      }

      return this.history.slice(-window);
    }

    if (window === undefined || window < 0) {
      return [...this.history];
    }

    if (window === 0) {
      return [];
    }

    return this.history.slice(-window);
  }

  /**
   * Apply only the global `historyWindow.agents` slice — used by the
   * recursive `ctx.intents.X.execute()` re-entry path where no
   * `RouteContext` is available to feed the per-entry slicer.
   */
  private applyAgentsWindow(): Message[] {
    const window = this.config.historyWindow?.agents;

    if (window === undefined || window < 0) {
      return [...this.history];
    }

    if (window === 0) {
      return [];
    }

    return this.history.slice(-window);
  }

  /**
   * Entry point. Wraps the core run (`runCore`) in the
   * `supervisor`-level middleware pipeline, then emits the terminal
   * `supervisor.cancelled` / `supervisor.error` / `supervisor.completed`
   * events and closes the stream (if any) with the post-pipeline result
   * — so a middleware that short-circuits or transforms the final
   * result still produces a well-formed public outcome. Returns the
   * uniform `{ data, report, usage, error }` shape. Never throws.
   */
  public async run(): Promise<SupervisorResult<TOutput>> {
    const context = this.buildSupervisorContext();

    let result: SupervisorResult<TOutput>;

    try {
      result = (await runPipeline(
        this.middleware,
        "supervisor",
        context,
        () => this.runCore(),
        this.logger,
      )) as SupervisorResult<TOutput>;
    } catch (thrown) {
      // A `supervisor`-level hook threw without recovery (or
      // `onError` returned void). The iteration loop's own failures
      // are already absorbed into `this.error` inside `runCore` and
      // never reach here — this catch covers middleware aborts and
      // any unexpected throw, funneling them into a well-formed
      // result so `supervisor.execute()` keeps its never-throws
      // contract.
      this.error = toAIError(thrown);
      this.status = this.error instanceof SupervisorCancelledError ? "cancelled" : "failed";
      this.terminatedBy = this.error instanceof SupervisorCancelledError ? "cancelled" : "error";

      if (this.error instanceof SupervisorCancelledError) {
        this.cancelledAtIso = this.error.cancelledAt;
      }

      if (this.error instanceof MaxIterationsError) {
        this.status = "max-iterations";
        this.terminatedBy = "max-iterations";
      }

      result = await this.finalize();
    }

    if (result.error) {
      if (this.status === "cancelled") {
        this.emit("supervisor.cancelled", {
          cancelledAt: this.cancelledAtIso ?? new Date().toISOString(),
          reason: (result.error as SupervisorCancelledError).reason,
        });
      } else {
        this.emit("supervisor.error", { error: result.error });
      }
    }

    this.emit("supervisor.completed", { result });

    this.streamController?.end(result);

    this.logger.info(this.logModule, "completed", "supervisor completed", {
      runId: this.runId,
      status: this.status,
      iterations: this.snapshots.length,
      duration: performance.now() - this.startPerf,
    });

    return result;
  }

  /**
   * Build the `supervisor`-level middleware context — the stable
   * identity of this run plus the per-run shared-state bag every hook
   * sees. Constructed once per run, before the pipeline `before` hooks
   * fire. Mirrors the agent's `buildExecuteContext`, one level up.
   */
  private buildSupervisorContext(): MiddlewareSupervisorContext {
    return {
      supervisor: {
        name: this.config.name,
        signature: this.signature,
      },
      input: this.input,
      options: this.options,
      state: this.middlewareState,
      signal: this.options?.signal,
    };
  }

  /**
   * Inner body wrapped by the `supervisor`-level pipeline. Emits the
   * `supervisor.starting` event, drives the iteration loop, absorbs
   * every iteration-loop failure into `this.error` (so the run never
   * throws from here), and returns the assembled `SupervisorResult`.
   * `supervisor`-level `after` hooks receive this result, with `error`
   * populated when the loop failed; `before` hooks can short-circuit
   * before this ever runs.
   */
  private async runCore(): Promise<SupervisorResult<TOutput>> {
    this.emit("supervisor.starting", {
      supervisorName: this.config.name,
      input: this.input,
    });

    this.logger.info(this.logModule, "starting", "supervisor starting", {
      runId: this.runId,
      maxIterations: this.maxIterations,
    });

    try {
      await this.runIterationLoop();
    } catch (thrown) {
      this.error = toAIError(thrown);
      this.status = this.error instanceof SupervisorCancelledError ? "cancelled" : "failed";
      this.terminatedBy = this.error instanceof SupervisorCancelledError ? "cancelled" : "error";

      if (this.error instanceof SupervisorCancelledError) {
        this.cancelledAtIso = this.error.cancelledAt;
      }

      if (this.error instanceof MaxIterationsError) {
        this.status = "max-iterations";
        this.terminatedBy = "max-iterations";
      }
    }

    return this.finalize();
  }

  /**
   * Drive the iteration loop until a terminal condition fires:
   * `END` / `satisfied:true` / `maxIterations` / signal abort /
   * routing error. Between-iteration cancellation is guaranteed —
   * the signal is checked before every iteration starts.
   */
  private async runIterationLoop(): Promise<void> {
    while (this.iteration < this.maxIterations) {
      this.throwIfCancelled();

      const continued = await this.runIteration();

      if (!continued) {
        return;
      }

      this.iteration += 1;
    }

    throw new MaxIterationsError(
      `supervisor "${this.config.name}" exceeded maxIterations=${this.maxIterations}`,
      { maxIterations: this.maxIterations },
    );
  }

  /**
   * Run one iteration end-to-end: decide → dispatch → evaluate →
   * snapshot. Returns `true` when the loop should continue to the
   * next iteration, `false` when this iteration terminated the run
   * (success or satisfied-verdict). Failures throw — the loop's
   * outer catch converts them into typed errors on the result.
   */
  private async runIteration(): Promise<boolean> {
    const iterationStartedAt = new Date();
    const iterationStart = performance.now();
    const iterationUsage: Usage = { input: 0, output: 0, total: 0 };

    // Phase 8 / decisions §38 — reset the captured-artifacts forensic
    // surface at iteration start so a snapshot built for an iteration
    // whose tools wrote nothing carries an empty bag, not a stale
    // carry-over from the prior iteration. `mergeArtifactsIntoState`
    // refreshes this with the live bag (frozen) before merge.
    this.capturedIterationArtifacts = Object.freeze({});

    this.emit("supervisor.iteration.starting", { iteration: this.iteration });

    // Kick off the receptionist (`ack`) in parallel with phase A's
    // dispatch decision — fires on iter 0 only when the run is fresh
    // (resumes don't re-emit; user already saw the original ack). The
    // promise is NOT awaited inline — `settleAck` probes it
    // non-blockingly later so a slow ack never extends total wall-
    // clock time. If ack hasn't settled by the probe point, its slice
    // is abandoned with a warning + error on the report.
    const ackPromise =
      this.iteration === 0 && !this.resumeFrom && this.config.ack ? this.runAck() : undefined;

    // Phase 7 / decisions §37 — classifier prelude. Runs once on iter 0
    // for fresh runs only (resumes inherit the prior classifier output
    // via state + report.classifier). Awaited inline because its
    // output drives the iter-0 dispatch decision; ack remains
    // non-blocking parallel by design.
    if (this.iteration === 0 && !this.resumeFrom && this.config.classifier) {
      await this.runClassifier();

      if (this.classifierHalted) {
        // Refine returned END (or classifier-alone mode interpreted
        // an END signal). Settle ack, mark terminated, capture a
        // synthetic decision snapshot, and exit the loop. State may
        // already carry refine's slice — do not clobber.
        await this.settleAck(ackPromise, iterationUsage);
        this.terminatedBy = "classifier";
        this.status = "completed";

        await this.recordTerminalDecisionSnapshot(
          {
            kind: "end",
            source: "classifier",
            raw: END,
            durationMs: 0,
          },
          iterationStartedAt,
          iterationStart,
          iterationUsage,
        );

        return false;
      }
    }

    const decision = await this.decideDispatch();

    this.aggregateUsage(iterationUsage, decision.usage);

    if (decision.kind === "end") {
      await this.settleAck(ackPromise, iterationUsage);
      this.terminatedBy = decision.source === "route" ? "route" : "router";
      this.status = "completed";

      await this.recordTerminalDecisionSnapshot(
        decision,
        iterationStartedAt,
        iterationStart,
        iterationUsage,
      );

      return false;
    }

    const branchSnapshots = await this.dispatchBranches(decision);

    for (const snapshot of branchSnapshots) {
      this.aggregateUsage(iterationUsage, snapshot.usage);
    }

    // Settle ack (if kicked off) before phase C merge. Probe is
    // non-blocking — `setImmediate` yields one macrotask cycle so an
    // already-resolved ack wins via microtask priority; otherwise the
    // probe returns NOT_READY and ack is abandoned (slice dropped,
    // warning logged, error captured on `report.ack`). Specialist
    // branches override the receptionist on key collision either way.
    await this.settleAck(ackPromise, iterationUsage);

    // Merge branch outputs into supervisor state in decision.intents
    // order so fan-out conflict resolution is deterministic — last
    // intent in the array wins on key collisions (Q15). Errored
    // branches don't contribute. Entries without an `output` schema
    // (agent/workflow) are NOT auto-merged — declaring the slice is
    // opt-in. Callbacks always merge (their full return value when
    // no schema; strip-merged when schema is declared) — they had
    // their schema applied inside runCallback already.
    this.mergeBranchesIntoState(decision.intents, branchSnapshots);

    // Phase 5 / decisions §35 — merge tool-side artifacts into state
    // AFTER branch slices land but BEFORE evaluate runs, so the
    // evaluate verdict sees the post-merge state including blocks /
    // citations / soft signals contributed by tools. Resets the bag
    // for the next iteration; long runs and orchestrator sessions
    // never accumulate raw artifacts.
    await this.mergeArtifactsIntoState();

    this.lastDispatchIntents = decision.intents;

    const evaluateVerdict = await this.runEvaluate(branchSnapshots);

    if (evaluateVerdict !== undefined && evaluateVerdict !== null) {
      this.emit("supervisor.evaluate.verdict", {
        iteration: this.iteration,
        verdict: evaluateVerdict,
      });
    }

    const iterationEndedAt = new Date();
    const duration = performance.now() - iterationStart;

    const snapshot: IterationSnapshot = Object.freeze({
      iteration: this.iteration,
      result: indexByIntent(branchSnapshots),
      decision: {
        source: decision.source,
        next: decision.raw,
        reasoning: decision.reasoning,
        durationMs: decision.durationMs,
      },
      evaluateVerdict,
      state: { ...this.state },
      artifacts: this.capturedIterationArtifacts,
      startedAt: iterationStartedAt.toISOString(),
      endedAt: iterationEndedAt.toISOString(),
      duration,
      usage: iterationUsage,
    });

    this.snapshots.push(snapshot);

    this.emit("supervisor.iteration.completed", {
      iteration: this.iteration,
      snapshot,
    });

    await this.checkpoint("running");

    if (evaluateVerdict?.satisfied) {
      this.terminatedBy = "evaluate";
      this.status = "completed";

      return false;
    }

    this.carriedFeedback = evaluateVerdict;

    // Stage 4d (Q24): when evaluate hasn't taken a stance via
    // `reassignTo`, collect each branch's `intent.next(ctx)` to drive
    // the next iteration without a router call. Evaluate's
    // `reassignTo` outranks `next` — if evaluate forced a target,
    // `next` doesn't get to vote.
    const evaluateForcedReassign =
      evaluateVerdict?.reassignTo !== undefined &&
      normalizeReassign(evaluateVerdict.reassignTo).length > 0;

    if (!evaluateForcedReassign) {
      const collected = this.collectIntentNext(decision.intents, branchSnapshots);

      if (collected?.kind === "end") {
        this.terminatedBy = "route";
        this.status = "completed";
        this.carriedNextDispatch = undefined;
        return false;
      }

      if (collected?.kind === "dispatch") {
        this.carriedNextDispatch = { intents: collected.intents };
      }
    }

    // Phase 7 / decisions §37 — classifier-alone supervisor auto-
    // terminates after iter 0's branch settles. Without router/route,
    // there's no decision source for iter 1; preempt the throw with
    // a clean termination. `intent.next` from iter 0's dispatched
    // intent still wins if it set a continuation (rare, but allowed).
    if (
      this.iteration === 0 &&
      this.config.classifier &&
      !this.config.router &&
      !this.config.route &&
      !this.carriedNextDispatch
    ) {
      this.terminatedBy = "classifier";
      this.status = "completed";

      return false;
    }

    return true;
  }

  /**
   * Resolve the dispatch decision for this iteration — defers to
   * `decide.ts`. When `carriedFeedback.reassignTo` is set the
   * supervisor overrides the router/route decision with an
   * evaluator-forced dispatch (design §2 — "Evaluate can override
   * router").
   */
  private async decideDispatch(): Promise<DispatchDecision> {
    if (this.config.router) {
      this.emit("supervisor.router.deciding", { iteration: this.iteration });
    }

    const reassignTo = normalizeReassign(this.carriedFeedback?.reassignTo);

    if (reassignTo.length > 0) {
      this.carriedNextDispatch = undefined;
      for (const intent of reassignTo) {
        if (!this.entries.has(intent)) {
          throw new SupervisorFailedError(
            `evaluate.reassignTo targeted unknown agent "${intent}"`,
            { context: { available: [...this.entries.keys()] } },
          );
        }
      }

      const decision: DispatchDecision = {
        kind: "dispatch",
        intents: reassignTo,
        source: "route",
        raw: reassignTo.length === 1 ? reassignTo[0] : reassignTo,
        durationMs: 0,
      };

      this.emit("supervisor.router.decided", {
        iteration: this.iteration,
        next: decision.raw,
        reasoning: this.carriedFeedback?.feedback,
        durationMs: 0,
      });

      return decision;
    }

    // Phase 7 / decisions §37 — classifier prelude (iter 0 only)
    // produced an intent dispatch decision. Skip router/route /
    // initialAgent entirely; classifier's pick wins. Cleared after
    // consumption — iter 1+ falls through to router/route as usual.
    if (this.carriedClassifierDispatch) {
      const carried = this.carriedClassifierDispatch;
      this.carriedClassifierDispatch = undefined;

      const decision: DispatchDecision = {
        kind: "dispatch",
        intents: [carried.intent],
        source: "classifier",
        raw: carried.intent,
        durationMs: 0,
      };

      this.emit("supervisor.router.decided", {
        iteration: this.iteration,
        next: decision.raw,
        reasoning: this.classifierSnapshot?.reasoning,
        durationMs: 0,
      });

      return decision;
    }

    // Stage 4d: per-intent `next` collected from the previous
    // iteration drives this dispatch — skip router/route entirely.
    if (this.carriedNextDispatch) {
      const carried = this.carriedNextDispatch;
      this.carriedNextDispatch = undefined;

      const decision: DispatchDecision = {
        kind: "dispatch",
        intents: carried.intents,
        source: "route",
        raw: carried.intents.length === 1 ? carried.intents[0] : carried.intents,
        durationMs: 0,
      };

      this.emit("supervisor.router.decided", {
        iteration: this.iteration,
        next: decision.raw,
        reasoning: undefined,
        durationMs: 0,
      });

      return decision;
    }

    const decision = await decide({
      config: this.config as SupervisorConfig<unknown>,
      entries: this.entries,
      iteration: this.iteration,
      maxIterations: this.maxIterations,
      iterations: this.snapshots,
      input: this.input,
      state: this.state,
      context: this.context,
      history: this.history,
      goal: this.goal,
      evaluateFeedback: this.carriedFeedback,
      classifier: this.classifierSnapshot,
      signal: this.options?.signal,
      useInitialAgent: this.iteration === 0 && !this.resumeFrom,
    });

    // Capture the router agent's report into the supervisor's tree so
    // router cost + internals are observable alongside dispatched
    // branches. Only present when decide() went through a router agent.
    if (decision.routerReport) {
      this.childReports.push(decision.routerReport);
    }

    this.emit("supervisor.router.decided", {
      iteration: this.iteration,
      next: decision.raw,
      reasoning: decision.reasoning,
      durationMs: decision.durationMs,
    });

    return decision;
  }

  /**
   * Dispatch every intent named by the decision in parallel. Per-
   * branch errors don't abort siblings — they're recorded on the
   * branch snapshot and let evaluate (or default termination logic)
   * decide the response.
   */
  private async dispatchBranches(
    decision: DispatchDecision & { kind: "dispatch" },
  ): Promise<AgentBranchSnapshot[]> {
    const branches = await Promise.all(decision.intents.map((intent) => this.dispatchOne(intent)));

    return branches;
  }

  /**
   * Execute a single branch — resolve the input, invoke the
   * agent / workflow / callback, apply the per-intent `output`
   * transformer, and produce an immutable `AgentBranchSnapshot`.
   */
  private async dispatchOne(intent: string): Promise<AgentBranchSnapshot> {
    const entry = this.entries.get(intent)!;

    if (entry.type === "callback") {
      return this.dispatchCallback(entry);
    }

    const routeContext: RouteContext = {
      iteration: this.iteration,
      input: this.input,
      state: this.state,
      iterations: this.snapshots,
      feedback:
        typeof this.carriedFeedback?.feedback === "string"
          ? this.carriedFeedback.feedback
          : undefined,
      evaluateFeedback: this.carriedFeedback,
      context: this.context,
      history: this.history,
      goal: this.goal,
      classifier: this.classifierSnapshot,
    };

    const resolvedInput = this.resolveBranchInput(entry, routeContext);
    const dispatchCtxForPlaceholders = this.seedDispatchContext(
      intent,
      resolvedInput,
      new Set<string>([intent]),
      [],
    );
    const placeholders = entry.placeholders
      ? entry.placeholders(dispatchCtxForPlaceholders)
      : undefined;

    this.emit("supervisor.agent.starting", {
      iteration: this.iteration,
      intent,
      input: resolvedInput,
    });

    const startedAt = new Date();
    const startPerf = performance.now();

    let rawResult: AgentResult<unknown> | WorkflowResult<unknown> | undefined;
    let branchError: AIError | undefined;
    let branchUsage: Usage = { input: 0, output: 0, total: 0 };

    try {
      rawResult = await this.invokeUnit(entry, resolvedInput, placeholders, routeContext);

      if (rawResult.error) {
        branchError = rawResult.error;
      }

      branchUsage = rawResult.usage;

      // Capture the child's execution report into the supervisor's
      // recursive tree. Each dispatched agent/workflow contributes
      // one BaseReport node; fan-out produces sibling children.
      if (rawResult.report) {
        this.childReports.push(rawResult.report);
      }
    } catch (thrown) {
      branchError = toAIError(thrown);
    }

    const sliceOutcome = await this.applyOutputSchema(entry, rawResult);
    const transformedOutput = sliceOutcome.value;
    if (sliceOutcome.error && !branchError) {
      branchError = sliceOutcome.error;
    }
    const endedAt = new Date();
    const duration = performance.now() - startPerf;

    const snapshot: AgentBranchSnapshot = Object.freeze({
      intent,
      input: resolvedInput,
      output: transformedOutput,
      usage: branchUsage,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      duration,
      error: branchError,
    });

    if (branchError) {
      this.emit("supervisor.agent.failed", {
        iteration: this.iteration,
        intent,
        error: branchError,
      });
    } else {
      this.emit("supervisor.agent.completed", {
        iteration: this.iteration,
        intent,
        output: transformedOutput,
        usage: branchUsage,
        duration,
      });
    }

    return snapshot;
  }

  /**
   * Dispatch a callback intent as a top-level branch — produces an
   * `AgentBranchSnapshot` and pushes the synthesized callback report
   * onto the supervisor's recursive children. Delegates the actual
   * callback invocation to {@link runCallback} so nested
   * `ctx.intents.X.execute()` calls can reuse the same machinery.
   *
   * Each branch dispatch starts with a fresh per-branch call stack —
   * sibling fan-out branches don't share cycle-detection state, so
   * branch A and branch B both invoking the same intent isn't a
   * cycle. The branch's own intent name is seeded onto the stack so
   * a callback that re-enters itself via `ctx.intents.X.execute()` trips
   * cycle detection on the first recursion.
   */
  private async dispatchCallback(entry: ResolvedCallbackEntry): Promise<AgentBranchSnapshot> {
    const intent = entry.intent;
    const callStack = new Set<string>([intent]);
    const callbackInput = entry.input
      ? entry.input(this.seedDispatchContext(intent, this.input, callStack, []))
      : this.input;
    const inputForSnapshot =
      typeof callbackInput === "string" ? callbackInput : safeStringify(callbackInput);

    this.emit("supervisor.agent.starting", {
      iteration: this.iteration,
      intent,
      input: inputForSnapshot,
    });

    const outcome = await this.runCallback(entry, callbackInput, callStack, this.childReports);

    const snapshot: AgentBranchSnapshot = Object.freeze({
      intent,
      input: inputForSnapshot,
      output: outcome.output,
      usage: outcome.report.usage,
      startedAt: outcome.report.startedAt,
      endedAt: outcome.report.endedAt,
      duration: outcome.report.duration,
      error: outcome.error,
    });

    if (outcome.error) {
      this.emit("supervisor.agent.failed", {
        iteration: this.iteration,
        intent,
        error: outcome.error,
      });
    } else {
      this.emit("supervisor.agent.completed", {
        iteration: this.iteration,
        intent,
        output: outcome.output,
        usage: outcome.report.usage,
        duration: outcome.report.duration,
      });
    }

    return snapshot;
  }

  /**
   * Run a callback intent and produce its leaf report + final
   * output. Used both for top-level branch dispatch (via
   * {@link dispatchCallback}) and for nested `dispatch.byName`
   * recursion. The synthesized report is appended to `reportSink`,
   * which is either `this.childReports` (top-level) or the calling
   * callback's own `children[]` (nested) — that's what gives the
   * unified report tree its compositional shape.
   *
   * Usage on the report rolls up children's usage; the callback
   * itself contributes zero (it's dev code, no token spend).
   */
  private async runCallback(
    entry: ResolvedCallbackEntry,
    input: unknown,
    callStack: Set<string>,
    reportSink: BaseReport[],
  ): Promise<{ output: unknown; error?: AIError; report: BaseReport }> {
    const childReports: BaseReport[] = [];
    const dispatchCtx: DispatchContext = this.seedDispatchContext(
      entry.intent,
      input,
      callStack,
      childReports,
    );

    const startedAt = new Date();
    const startPerf = performance.now();

    let rawOutput: unknown;
    let error: AIError | undefined;

    try {
      rawOutput = await entry.callback(dispatchCtx);
    } catch (thrown) {
      error =
        thrown instanceof AIError
          ? thrown
          : new SupervisorFailedError(
              `callback intent "${entry.intent}" threw: ${
                thrown instanceof Error ? thrown.message : String(thrown)
              }`,
              { cause: thrown },
            );
    }

    let transformedOutput: unknown = rawOutput;

    if (!error && entry.output) {
      const validation = await entry.output["~standard"].validate(rawOutput);
      if (validation.issues) {
        error = new SchemaValidationError(
          `intent "${entry.intent}" output failed validation: ${validation.issues
            .map((issue) => issue.message)
            .join("; ")}`,
          { issues: validation.issues },
        );
        transformedOutput = undefined;
      } else {
        transformedOutput = validation.value;
      }
    }

    const endedAt = new Date();
    const duration = performance.now() - startPerf;
    const rolledUsage = aggregateChildUsage(childReports);

    const report: BaseReport = {
      runId: `${this.runId}.${entry.intent}`,
      rootRunId: this.runId,
      name: entry.intent,
      type: "callback",
      status: error ? "failed" : "completed",
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      duration,
      usage: rolledUsage,
      children: childReports,
    };

    reportSink.push(report);

    return { output: transformedOutput, error, report };
  }

  /**
   * Build a {@link DispatchContext} with a typed `intents` map of
   * `IntentRunner` closures, each closing over the supplied call
   * stack and report sink. Cycle detection uses the call stack —
   * re-entering an intent already on it throws
   * `SupervisorFailedError` with code `SUPERVISOR_DISPATCH_CYCLE`
   * and the offending chain in the message.
   *
   * Replaces the Phase-3.3 `ctx.dispatch.byName` plumbing with
   * property-access on a typed map (Q5/Q6) — autocomplete, no typo
   * crashes, `.execute()` matches every other primitive's verb.
   */
  private seedDispatchContext(
    intent: string,
    input: unknown,
    callStack: Set<string>,
    reportSink: BaseReport[],
  ): DispatchContext {
    type RunnerSlot = {
      execute: (input?: unknown) => Promise<unknown>;
      stream: (input?: unknown) => unknown;
    };
    const intentsMap: Record<string, RunnerSlot> = {};

    for (const target of this.entries.keys()) {
      intentsMap[target] = {
        execute: (override?: unknown) =>
          this.runIntent(target, override === undefined ? input : override, callStack, reportSink),
        stream: (override?: unknown) =>
          this.streamIntent(
            target,
            override === undefined ? input : override,
            callStack,
            reportSink,
            intent,
          ),
      };
    }

    return {
      iteration: this.iteration,
      intent,
      input,
      state: this.state,
      result: {},
      iterations: this.snapshots,
      signal: this.options?.signal ?? new AbortController().signal,
      intents: intentsMap as DispatchContext["intents"],
      context: this.context,
      history: this.history,
      goal: this.goal,
      run: (executable, runInput, runOptions) =>
        this.runInline(executable, runInput, runOptions, callStack, reportSink),
      stream: (executable, runInput, runOptions) =>
        this.streamInline(executable, runInput, runOptions, callStack, reportSink, intent),
      classifier: this.classifierSnapshot,
    } as DispatchContext;
  }

  /**
   * Backing implementation for `ctx.intents.X.execute(input?)`.
   * Looks up the named intent in the supervisor's registry, asserts
   * the call wouldn't close a cycle, and runs the dispatchable
   * through the same machinery a top-level branch would — except
   * the resulting report nests under the calling callback's
   * `children[]` rather than the supervisor's top-level child list,
   * and only the final output is returned (no snapshot).
   */
  private async runIntent(
    target: string,
    callerInput: unknown,
    callStack: Set<string>,
    reportSink: BaseReport[],
  ): Promise<unknown> {
    if (callStack.has(target)) {
      const chain = [...callStack, target].join(" → ");
      throw new SupervisorFailedError(
        `ctx.intents.${target}.execute: cycle detected (${chain})`,
        { context: { intent: target } },
        "SUPERVISOR_DISPATCH_CYCLE",
      );
    }

    const entry = this.entries.get(target);

    if (!entry) {
      throw new SupervisorFailedError(
        `ctx.intents.${target}.execute: unknown intent "${target}" — must be a key in the supervisor's \`intents\` map`,
        { context: { intent: target } },
      );
    }

    callStack.add(target);

    try {
      if (entry.type === "callback") {
        const { output, error } = await this.runCallback(entry, callerInput, callStack, reportSink);

        if (error) {
          throw error;
        }

        return output;
      }

      // Agent / workflow path. The unified-report tree gets the
      // child's report under the calling callback's children — we
      // intentionally do NOT also push to `this.childReports` (that
      // would double-count). The agent/workflow's own usage flows
      // up through the callback's roll-up.
      const inputString =
        typeof callerInput === "string" ? callerInput : safeStringify(callerInput);

      if (entry.type === "agent") {
        // Recursive `ctx.intents.X.execute()` re-entry path — no
        // `RouteContext` constructed here, so the per-entry slicer is
        // skipped; only the global `historyWindow.agents` window
        // applies. The original outer dispatch already passed a sliced
        // view; this sub-call mirrors that behavior.
        const reentryHistory = this.applyAgentsWindow();
        const result = await entry.unit.execute(inputString, {
          signal: this.options?.signal,
          ...(reentryHistory.length > 0 ? { history: reentryHistory } : {}),
        });

        if (result.report) {
          reportSink.push(result.report);
        }

        if (result.error) {
          throw result.error;
        }

        return result.data ?? result.text ?? undefined;
      }

      // workflow
      const result = await entry.unit.execute(inputString as never, {
        signal: this.options?.signal,
      });

      if (result.report) {
        reportSink.push(result.report);
      }

      if (result.error) {
        throw result.error;
      }

      return result.data;
    } finally {
      callStack.delete(target);
    }
  }

  /**
   * Backing implementation for `ctx.intents.X.stream(input?)` (Phase 6
   * / decisions §36). Streaming sibling of {@link runIntent} — same
   * cycle protection, same auto-merge of supervisor-level concerns,
   * but routes through the unit's `.stream()` method when available
   * and bubbles deltas as `supervisor.agent.streaming` under the
   * **calling callback's** intent name (not the dispatched intent's).
   */
  private streamIntent(
    target: string,
    callerInput: unknown,
    callStack: Set<string>,
    reportSink: BaseReport[],
    callerIntent: string,
  ): StreamContract<SupervisableResult> {
    if (callStack.has(target)) {
      const chain = [...callStack, target].join(" → ");
      throw new SupervisorFailedError(
        `ctx.intents.${target}.stream: cycle detected (${chain})`,
        { context: { intent: target } },
        "SUPERVISOR_DISPATCH_CYCLE",
      );
    }

    const entry = this.entries.get(target);

    if (!entry) {
      throw new SupervisorFailedError(
        `ctx.intents.${target}.stream: unknown intent "${target}" — must be a key in the supervisor's \`intents\` map`,
        { context: { intent: target } },
      );
    }

    if (entry.type === "callback") {
      throw new SupervisorFailedError(
        `ctx.intents.${target}.stream: callback intents are not streamable — use \`.execute(input?)\` instead`,
        { context: { intent: target } },
      );
    }

    callStack.add(target);

    const inputString = typeof callerInput === "string" ? callerInput : safeStringify(callerInput);

    return this.streamSupervisedExecutable(
      entry.unit as StreamableExecutable,
      inputString,
      undefined,
      callerIntent,
      reportSink,
      () => callStack.delete(target),
    );
  }

  /**
   * Backing implementation for `ctx.run(executable, input, options?)`
   * (Phase 6 / decisions §36). Runs an inline / un-registered
   * executable under supervision: auto-merges `signal`, `toolCtx`,
   * `history` defaults; nests the resulting report under the
   * calling callback's `children[]`. Per-call options REPLACE auto-
   * defaults — standard Warlock convention.
   *
   * Cycle protection by executable `name` matches the registered-
   * intent path so a callback that recurses on the same agent trips
   * the same error, regardless of whether the agent was looked up
   * via `ctx.intents.X.execute()` or passed inline.
   */
  private async runInline(
    executable: SupervisableExecutable,
    input: unknown,
    options: SupervisableExecuteOptions | undefined,
    callStack: Set<string>,
    reportSink: BaseReport[],
  ): Promise<SupervisableResult> {
    const name = executable.name;

    if (callStack.has(name)) {
      const chain = [...callStack, name].join(" → ");
      throw new SupervisorFailedError(
        `ctx.run("${name}"): cycle detected (${chain})`,
        { context: { intent: name } },
        "SUPERVISOR_DISPATCH_CYCLE",
      );
    }

    callStack.add(name);

    try {
      const merged = this.mergeInlineOptions(options);
      const inputForExecutable = this.coerceInlineInput(executable, input);
      const result = (await (
        executable as {
          execute: (input: unknown, options?: unknown) => Promise<SupervisableResult>;
        }
      ).execute(inputForExecutable, merged)) as SupervisableResult;

      if (result.report) {
        reportSink.push(result.report);
      }

      return result;
    } finally {
      callStack.delete(name);
    }
  }

  /**
   * Backing implementation for `ctx.stream(executable, input, options?)`
   * (Phase 6 / decisions §36). Streaming sibling of {@link runInline}.
   * Routes through the executable's native `.stream()` method,
   * subscribes to delta events, and bubbles them as
   * `supervisor.agent.streaming` under the calling callback's intent
   * name. The returned `StreamContract` is the executable's own —
   * iteration and `.result` work identically.
   *
   * Cycle protection on entry mirrors {@link runInline}; release runs
   * after `.result` settles so a same-callback recursion is caught
   * regardless of which path closed the cycle.
   */
  private streamInline(
    executable: StreamableExecutable,
    input: unknown,
    options: SupervisableExecuteOptions | undefined,
    callStack: Set<string>,
    reportSink: BaseReport[],
    callerIntent: string,
  ): StreamContract<SupervisableResult> {
    const name = executable.name;

    if (callStack.has(name)) {
      const chain = [...callStack, name].join(" → ");
      throw new SupervisorFailedError(
        `ctx.stream("${name}"): cycle detected (${chain})`,
        { context: { intent: name } },
        "SUPERVISOR_DISPATCH_CYCLE",
      );
    }

    callStack.add(name);

    return this.streamSupervisedExecutable(
      executable,
      this.coerceInlineInput(executable, input),
      options,
      callerIntent,
      reportSink,
      () => callStack.delete(name),
    );
  }

  /**
   * Shared wiring for both `ctx.intents.X.stream()` and
   * `ctx.stream(...)`. Subscribes to the executable's stream, re-
   * emits deltas as `supervisor.agent.streaming` under the calling
   * callback's intent name, and pushes the inner report onto the
   * reportSink once `.result` settles. The returned StreamContract
   * is the executable's own — the framework attaches handlers
   * transparently via `.on(...)`.
   */
  private streamSupervisedExecutable(
    executable: StreamableExecutable,
    input: unknown,
    options: SupervisableExecuteOptions | undefined,
    callerIntent: string,
    reportSink: BaseReport[],
    release: () => void,
  ): StreamContract<SupervisableResult> {
    const merged = this.mergeInlineOptions(options);
    const stream = (
      executable as {
        stream: (input: unknown, options?: unknown) => StreamContract<SupervisableResult>;
      }
    ).stream(input, merged);

    // Bubble inner deltas under the CALLING callback's intent name.
    // Agents fire `agent.trip.streaming`; supervisors fire
    // `supervisor.agent.streaming` already — the inner intent name
    // there is the inner supervisor's specialist, which we replace
    // with the outer callback's name so attribution is consistent.
    const handlers: Record<string, (event: { delta: string }) => void> = {
      "agent.trip.streaming": ({ delta }) => {
        this.emit("supervisor.agent.streaming", {
          iteration: this.iteration,
          intent: callerIntent,
          delta,
        });
      },
      "supervisor.agent.streaming": ({ delta }) => {
        this.emit("supervisor.agent.streaming", {
          iteration: this.iteration,
          intent: callerIntent,
          delta,
        });
      },
    };

    stream.on(handlers);

    // Always release the cycle-protection slot after `.result` settles
    // (success OR failure) so subsequent calls in the same callback
    // see a clean stack. Push report on success.
    void stream.result.then(
      (result) => {
        if (result?.report) {
          reportSink.push(result.report);
        }

        release();
      },
      () => release(),
    );

    return stream;
  }

  /**
   * Build the options object passed into an inline `.execute()` /
   * `.stream()` call. Auto-merges supervisor-level defaults
   * (`signal`, `toolCtx`, `history` window) under the caller's
   * options. Per-call values REPLACE the auto-defaults — when the
   * dev passes `signal: undefined` they explicitly opt out.
   */
  private mergeInlineOptions(
    options: SupervisableExecuteOptions | undefined,
  ): SupervisableExecuteOptions {
    const supplied = (options ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...supplied };

    if (!("signal" in supplied)) {
      merged.signal = this.options?.signal;
    }

    if (!("toolCtx" in supplied)) {
      merged.toolCtx = {
        artifacts: this.currentArtifacts,
        signal: this.options?.signal,
      };
    }

    if (!("history" in supplied)) {
      const window = this.applyAgentsWindow();

      if (window.length > 0) {
        merged.history = window;
      }
    }

    return merged as SupervisableExecuteOptions;
  }

  /**
   * Coerce an arbitrary inline input into the shape the underlying
   * executable expects. Agents take `string`; workflows + supervisors
   * take whatever they declared. We safe-stringify objects only when
   * passing to an agent — workflow / supervisor calls hand the value
   * through unchanged so structured inputs work.
   */
  private coerceInlineInput(executable: SupervisableExecutable, input: unknown): unknown {
    // Agents are the only kind that strictly require string input.
    // Workflows / supervisors accept arbitrary shapes.
    const isAgent =
      !("signature" in executable) &&
      typeof executable.execute === "function" &&
      !this.isSupervisor(executable);

    if (isAgent && typeof input !== "string") {
      return safeStringify(input);
    }

    return input;
  }

  /**
   * Heuristic detection of `SupervisorContract` — the contract carries
   * a `signature` getter same as workflows, but supervisors expose
   * `resume()` while workflows expose `resume(runId, options)` too.
   * Cleanest distinguisher in the public surface: supervisors carry
   * the `asTool` method name `as` … unfortunately so do workflows.
   * Use the `streamableType` brand if we add one in v2; for now lean
   * on a duck-typed check that's good enough for the ctx.run path
   * (incorrect routing for workflows would still produce a runnable
   * call — workflow.execute accepts the same args either way).
   */
  private isSupervisor(executable: SupervisableExecutable): boolean {
    return (
      typeof (executable as { resume?: unknown; signature?: unknown }).resume === "function" &&
      typeof (executable as { signature?: unknown }).signature === "string" &&
      typeof (executable as { stream?: unknown }).stream === "function"
    );
  }

  /**
   * Invoke the underlying dispatchable unit. Agents and workflows
   * both satisfy `ExecutableContract<string, …>` so the call shape
   * is uniform; the `type` discriminator picks which options get
   * threaded through (e.g. per-call stream event bubbling for
   * agents, which we wire inline so child agent tokens surface as
   * `supervisor.agent.streaming`).
   */
  private async invokeUnit(
    entry: Exclude<ResolvedIntentEntry, ResolvedCallbackEntry>,
    input: string,
    placeholders: Record<string, unknown> | undefined,
    routeContext: RouteContext,
  ): Promise<AgentResult<unknown> | WorkflowResult<unknown>> {
    // When the supervisor itself is being streamed by the caller, run
    // the child agent in streaming mode too — that's the only way
    // token deltas surface up the tree as `supervisor.agent.streaming`
    // events. `agent.execute()` always uses `model.complete()` which
    // never fires `agent.trip.streaming`, so wiring a callback there
    // is a silent no-op for tokens. Lifecycle events (trip.started /
    // tool.called / completed) still fire through `.on()` regardless
    // — they're driven by orchestration boundaries, not the wire mode.
    const isStreaming = this.streamController !== undefined;

    if (entry.type === "agent") {
      // `type` and `unit` aren't a discriminated union on the entry
      // type — narrow manually. `resolveIntentEntries` guarantees
      // `unit` matches `type` at runtime.
      const agent = entry.unit as AgentContract<unknown>;
      const handlers = {
        "agent.trip.streaming": ({ delta }: { delta: string }) => {
          this.emit("supervisor.agent.streaming", {
            iteration: this.iteration,
            intent: entry.intent,
            delta,
          });
        },
      };

      // Phase 5 / decisions §34 — stream-mode intents drop the
      // structured-output schema (factory already rejects coexistence)
      // and always run via `agent.stream()` so token deltas surface as
      // `supervisor.agent.streaming` events regardless of whether the
      // top-level caller streamed the supervisor.
      const isStreamMode = entry.mode === "stream";

      // Stage 4b/4d: forward `intent.output` as the agent's per-call
      // output schema when declared. The agent then parses model
      // output as structured data; `applyOutputSchema` re-validates
      // (cheap) and strip-merges into supervisor state.
      const resolvedHistory = this.resolveHistoryFor("agents", routeContext, entry.history);
      const agentOptions = {
        signal: this.options?.signal,
        on: handlers,
        ...(placeholders ? { placeholders } : {}),
        ...(entry.output && !isStreamMode ? { output: entry.output } : {}),
        ...(resolvedHistory.length > 0 ? { history: resolvedHistory } : {}),
        toolCtx: {
          artifacts: this.currentArtifacts,
          signal: this.options?.signal,
        },
      };

      if (isStreamMode || isStreaming) {
        const childStream = agent.stream(input, agentOptions);
        return childStream.result;
      }

      return agent.execute(input, agentOptions);
    }

    const workflow = entry.unit as WorkflowInstance<unknown, unknown>;

    return workflow.execute(input, {
      signal: this.options?.signal,
      on: {
        "workflow.step.streaming": ({ delta }) => {
          this.emit("supervisor.agent.streaming", {
            iteration: this.iteration,
            intent: entry.intent,
            delta,
          });
        },
      },
    });
  }

  /**
   * Build the input string passed to a branch's child execution.
   * Default: pass the supervisor's original `ctx.input` through
   * unchanged. The per-intent `entry.input` override is the escape
   * hatch for the rare case where the agent's user message itself
   * must vary per intent.
   *
   * Q17 lock: dropped `composeAgentInput` + `defaultComposeAgentInput`.
   * Their three jobs (carry original / prior outputs / feedback) all
   * have cleaner homes in the new model — original is the input
   * itself, prior outputs are state (Stage 4b), feedback is a
   * router-only signal (Q18).
   */
  private resolveBranchInput(
    entry: Exclude<ResolvedIntentEntry, ResolvedCallbackEntry>,
    ctx: RouteContext,
  ): string {
    const override = entry.input?.(ctx);

    if (typeof override === "string") {
      return override;
    }

    // Q1: supervisor-level input may be an object payload. Agents
    // need a string — JSON-stringify when no per-intent override
    // converted it. Devs wanting a different shape supply
    // `entry.input(ctx)`.
    return typeof ctx.input === "string" ? ctx.input : safeStringify(ctx.input);
  }

  /**
   * Strip-merge the agent/workflow's raw output against the per-intent
   * `output` schema (Q11/Q13). Returns the validated slice that:
   *
   *   1. Lands on `IterationSnapshot.result[intent].output` (so
   *      consumers see the same shape that hit state).
   *   2. Shallow-merges into `this.state` (handled by the caller).
   *
   * When `entry.output` is omitted the agent's full `data` (or `text`
   * fallback for unstructured agents) flows through unvalidated — but
   * is NOT auto-merged into state. State contribution is opt-in via
   * declaring the slice schema.
   *
   * Validation failure surfaces as a per-branch error on the
   * snapshot; sibling branches still run.
   */
  private async applyOutputSchema(
    entry: Exclude<ResolvedIntentEntry, ResolvedCallbackEntry>,
    raw: AgentResult<unknown> | WorkflowResult<unknown> | undefined,
  ): Promise<{ value: unknown; error?: AIError }> {
    if (!raw) {
      return { value: undefined };
    }

    const sourceValue = isAgentResult(raw)
      ? (raw.data ?? raw.text ?? undefined)
      : isWorkflowResult(raw)
        ? raw.data
        : undefined;

    // Phase 5 / decisions §34 — stream-mode agents have no `output`
    // schema. The assembled prose comes back as `raw.text` (the agent
    // never produced structured `data` because we dropped the schema
    // in `invokeUnit`). Wrap it as `{ [streamTo]: text }` so the
    // existing strip-merge path lands the prose under the named state
    // key without further special-casing downstream.
    if (entry.type === "agent" && entry.mode === "stream") {
      const text = typeof sourceValue === "string" ? sourceValue : "";

      return { value: { [entry.streamTo as string]: text } };
    }

    if (!entry.output) {
      return { value: sourceValue };
    }

    const validation = await entry.output["~standard"].validate(sourceValue);

    if (validation.issues) {
      return {
        value: undefined,
        error: new SchemaValidationError(
          `intent "${entry.intent}" output failed validation: ${validation.issues
            .map((issue) => issue.message)
            .join("; ")}`,
          { issues: validation.issues },
        ),
      };
    }

    return { value: validation.value };
  }

  /**
   * Fire the receptionist (`ack`) — runs in parallel with phase A on
   * iteration 0 only. Accepts three shapes:
   *
   * - `AckEntry` — `{ agent, placeholders?, input?, output? }`. LLM
   *   form. Streams tokens via `supervisor.ack.streaming`; report
   *   node pushes onto `childReports[]`.
   * - `AckRunEntry` — `{ run, output? }`. Pure-code callback. Settles
   *   without an LLM call. No streaming events; just `.completed`.
   * - `AckCallback` — bare `(ctx) => slice` shorthand for the
   *   pure-code form when no schema is declared.
   *
   * Failures are recorded but never abort the run — the receptionist
   * tripping doesn't stop the specialist from doing the actual job.
   * The returned outcome is what `mergeAckIntoState` consumes.
   */
  private async runAck(): Promise<
    | {
        output: unknown;
        usage: Usage;
        duration: number;
        error?: AIError;
      }
    | undefined
  > {
    const ack = this.config.ack;
    if (!ack) return undefined;

    const routeContext: RouteContext = {
      iteration: this.iteration,
      input: this.input,
      state: this.state,
      iterations: this.snapshots,
      feedback:
        typeof this.carriedFeedback?.feedback === "string"
          ? this.carriedFeedback.feedback
          : undefined,
      evaluateFeedback: this.carriedFeedback,
      context: this.context,
      history: this.history,
      goal: this.goal,
      classifier: this.classifierSnapshot,
    };

    const startedAt = new Date();
    const startPerf = performance.now();

    // Bare-callback shorthand: `ack: (ctx) => slice`.
    if (typeof ack === "function") {
      return this.runAckCallback(
        ack as (ctx: RouteContext) => unknown | Promise<unknown>,
        undefined,
        routeContext,
        startedAt,
        startPerf,
      );
    }

    // Run-entry form: `ack: { run, output? }`.
    if ("run" in ack && typeof (ack as { run?: unknown }).run === "function") {
      const runEntry = ack as {
        run: (ctx: RouteContext) => unknown | Promise<unknown>;
        output?: StandardSchemaV1<unknown>;
      };
      return this.runAckCallback(runEntry.run, runEntry.output, routeContext, startedAt, startPerf);
    }

    // Agent-entry form: `ack: { agent, placeholders?, input?, output? }`.
    return this.runAckAgent(
      ack as {
        agent: import("../contracts/agent/agent.contract").AgentContract<unknown>;
        placeholders?: (ctx: RouteContext) => Record<string, unknown>;
        input?: (ctx: RouteContext) => string;
        output?: StandardSchemaV1<unknown>;
        history?: (ctx: RouteContext) => Message[] | ReadonlyArray<Message>;
      },
      routeContext,
      startedAt,
      startPerf,
    );
  }

  /**
   * Pure-code receptionist path — invokes the callback, strip-validates
   * the return value (when an `output` schema is declared), records the
   * snapshot, emits `supervisor.ack.completed`, returns the outcome.
   * No streaming events fire (callbacks settle synchronously from the
   * supervisor's POV).
   */
  private async runAckCallback(
    run: (ctx: RouteContext) => unknown | Promise<unknown>,
    output: StandardSchemaV1<unknown> | undefined,
    routeContext: RouteContext,
    startedAt: Date,
    startPerf: number,
  ): Promise<{
    output: unknown;
    usage: Usage;
    duration: number;
    error?: AIError;
  }> {
    const usage: Usage = { input: 0, output: 0, total: 0 };
    let validatedOutput: unknown;
    let ackError: AIError | undefined;

    try {
      const raw = await run(routeContext);

      if (output) {
        const validation = await output["~standard"].validate(raw);
        if (validation.issues) {
          ackError = new SchemaValidationError(
            `ack output failed validation: ${validation.issues
              .map((issue) => issue.message)
              .join("; ")}`,
            { issues: validation.issues },
          );
        } else {
          validatedOutput = validation.value;
        }
      } else {
        validatedOutput = raw;
      }
    } catch (thrown) {
      ackError = toAIError(thrown);
    }

    const endedAt = new Date();
    const duration = performance.now() - startPerf;

    this.ackSnapshot = Object.freeze({
      input: typeof this.input === "string" ? this.input : safeStringify(this.input),
      output: validatedOutput,
      usage,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      duration,
      error: ackError,
    });

    this.emit("supervisor.ack.completed", {
      output: validatedOutput,
      usage,
      duration,
      error: ackError,
    });

    return { output: validatedOutput, usage, duration, error: ackError };
  }

  /**
   * Agent-driven receptionist path — invokes the agent, streams tokens
   * via `supervisor.ack.streaming`, captures the report node, strip-
   * validates against `output` (when declared), records the snapshot,
   * emits `supervisor.ack.completed`.
   */
  private async runAckAgent(
    ack: {
      agent: import("../contracts/agent/agent.contract").AgentContract<unknown>;
      placeholders?: (ctx: RouteContext) => Record<string, unknown>;
      input?: (ctx: RouteContext) => string;
      output?: StandardSchemaV1<unknown>;
      history?: (ctx: RouteContext) => Message[] | ReadonlyArray<Message>;
    },
    routeContext: RouteContext,
    startedAt: Date,
    startPerf: number,
  ): Promise<{
    output: unknown;
    usage: Usage;
    duration: number;
    error?: AIError;
  }> {
    const placeholders = ack.placeholders?.(routeContext);
    const inputForAck =
      ack.input?.(routeContext) ??
      (typeof this.input === "string" ? this.input : safeStringify(this.input));

    const isStreaming = this.streamController !== undefined;

    const handlers = {
      "agent.trip.streaming": ({ delta }: { delta: string }) => {
        this.emit("supervisor.ack.streaming", { delta });
      },
    };

    const resolvedHistory = this.resolveHistoryFor("ack", routeContext, ack.history);
    const agentOptions = {
      signal: this.options?.signal,
      on: handlers,
      ...(placeholders ? { placeholders } : {}),
      ...(ack.output ? { output: ack.output } : {}),
      ...(resolvedHistory.length > 0 ? { history: resolvedHistory } : {}),
    };

    let rawResult: AgentResult<unknown> | undefined;
    let ackError: AIError | undefined;
    let usage: Usage = { input: 0, output: 0, total: 0 };

    try {
      if (isStreaming) {
        const childStream = ack.agent.stream(inputForAck, agentOptions);
        rawResult = await childStream.result;
      } else {
        rawResult = await ack.agent.execute(inputForAck, agentOptions);
      }

      if (rawResult.error) {
        ackError = rawResult.error;
      }

      usage = rawResult.usage ?? usage;

      // Ack agent's report node in the supervisor's recursive tree.
      if (rawResult.report) {
        this.childReports.push(rawResult.report);
      }
    } catch (thrown) {
      ackError = toAIError(thrown);
    }

    const endedAt = new Date();
    const duration = performance.now() - startPerf;

    // Strip-validate against `ack.output` (when declared) — same
    // contract as per-intent output schemas.
    let validatedOutput: unknown;
    if (rawResult && !ackError && ack.output) {
      const sourceValue = rawResult.data ?? rawResult.text ?? undefined;
      const validation = await ack.output["~standard"].validate(sourceValue);
      if (validation.issues) {
        ackError = new SchemaValidationError(
          `ack output failed validation: ${validation.issues
            .map((issue) => issue.message)
            .join("; ")}`,
          { issues: validation.issues },
        );
      } else {
        validatedOutput = validation.value;
      }
    } else if (rawResult && !ackError) {
      validatedOutput = rawResult.data ?? rawResult.text ?? undefined;
    }

    this.ackSnapshot = Object.freeze({
      input: inputForAck,
      output: validatedOutput,
      usage,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      duration,
      error: ackError,
    });

    this.emit("supervisor.ack.completed", {
      output: validatedOutput,
      usage,
      duration,
      error: ackError,
    });

    return { output: validatedOutput, usage, duration, error: ackError };
  }

  /**
   * Probe the ack promise non-blockingly. Yields one macrotask cycle
   * (`setImmediate`) so an already-resolved ack wins via microtask
   * priority; if the probe returns first, the slice is abandoned —
   * warning logged, error captured on `report.ack`, run completes
   * regardless. Specialists own the actual answer; the receptionist
   * was just a reassuring preview.
   */
  private async settleAck(
    ackPromise:
      | Promise<{ output: unknown; usage: Usage; duration: number; error?: AIError } | undefined>
      | undefined,
    iterationUsage: Usage,
  ): Promise<void> {
    if (!ackPromise) return;

    const NOT_READY = Symbol("ack-not-ready");
    const probe = await Promise.race([
      ackPromise,
      new Promise<typeof NOT_READY>((resolve) => setTimeout(() => resolve(NOT_READY), 0)),
    ]);

    if (probe === NOT_READY) {
      this.logger.warn(
        this.logModule,
        "ack.abandoned",
        "ack receptionist did not settle before iteration completed; slice dropped",
      );
      const abandonedAt = new Date();
      this.ackSnapshot = Object.freeze({
        input: typeof this.input === "string" ? this.input : safeStringify(this.input),
        output: undefined,
        usage: { input: 0, output: 0, total: 0 },
        startedAt: abandonedAt.toISOString(),
        endedAt: abandonedAt.toISOString(),
        duration: 0,
        error: new SupervisorFailedError(
          "ack receptionist did not settle before iteration completed",
          { context: { ackAbandoned: true } },
        ),
      });
      return;
    }

    const ackOutcome = probe;
    if (ackOutcome) {
      this.aggregateUsage(iterationUsage, ackOutcome.usage);
      this.mergeAckIntoState(ackOutcome);
    }
  }

  /**
   * Merge the receptionist's strip-validated slice into state. Called
   * from `settleAck` BEFORE branch merges so specialists override the
   * receptionist on key collision — the receptionist hedges, the
   * specialist commits.
   */
  private mergeAckIntoState(ackOutcome: { output: unknown; error?: AIError }): void {
    if (ackOutcome.error || !ackOutcome.output) return;

    if (typeof ackOutcome.output !== "object" || ackOutcome.output === null) return;

    const slice = ackOutcome.output as Record<string, unknown>;

    for (const [key, value] of Object.entries(slice)) {
      this.state[key] = value;
    }
  }

  /**
   * Run the iter-0 classifier prelude (Phase 7 / decisions §37).
   * Resolves the configured classifier (agent / callback / entry
   * form), invokes it, runs the optional `refine` post-process hook,
   * and either:
   *
   *   - sets `carriedClassifierDispatch` so the upcoming
   *     `decideDispatch` short-circuits to the chosen intent, OR
   *   - sets `classifierHalted = true` so `runIteration` terminates
   *     before any dispatch (refine returned `END`).
   *
   * Captures the full forensic record on `classifierSnapshot` —
   * surfaced on `SupervisorReport.classifier` and threaded into
   * `ctx.classifier` on every downstream context.
   *
   * Errors in the classifier OR the refine hook abort the run with
   * a `SupervisorFailedError` so issues surface loudly instead of
   * silently falling through to router/route.
   */
  private async runClassifier(): Promise<void> {
    const startedAt = new Date();
    const startPerf = performance.now();
    const startedAtIso = startedAt.toISOString();

    this.emit("supervisor.classifier.starting", { iteration: 0 });

    const ctx = this.buildClassifierContext();
    const config = this.config.classifier as ClassifierConfig;

    let raw: ClassifierOutput | undefined;
    let usage: Usage = { input: 0, output: 0, total: 0 };
    let executionError: AIError | undefined;

    try {
      const outcome = await this.invokeClassifier(config, ctx);
      raw = outcome.output;
      usage = outcome.usage;
    } catch (thrown) {
      executionError = toAIError(thrown);
    }

    if (executionError || !raw) {
      const error =
        executionError ??
        new SupervisorFailedError(
          `ai.supervisor("${this.config.name}"): classifier produced no output`,
          { context: { iteration: 0 } },
        );

      this.classifierSnapshot = {
        intent: undefined,
        refined: false,
        halted: true,
        raw: raw ?? { intent: "" },
        startedAt: startedAtIso,
        endedAt: new Date().toISOString(),
        duration: performance.now() - startPerf,
        usage,
        error,
      };

      this.aggregateUsage(this.usage, usage);

      this.emit("supervisor.classifier.failed", { error });

      // Classifier failure aborts the run — no fallback to router/route.
      // Phase 7 / decisions §37.
      throw error;
    }

    // Validate the classifier's chosen intent against the registry
    // before running refine — refine may override, but we still want
    // to fail fast on raw classifier output that targets nothing.
    if (!this.entries.has(raw.intent)) {
      const error = new SupervisorFailedError(
        `ai.supervisor("${this.config.name}"): classifier picked unknown intent "${raw.intent}" — must be a key in \`intents\``,
        { context: { iteration: 0, available: [...this.entries.keys()] } },
        "SUPERVISOR_INVALID_ROUTE",
      );

      this.classifierSnapshot = {
        intent: undefined,
        refined: false,
        halted: true,
        raw,
        startedAt: startedAtIso,
        endedAt: new Date().toISOString(),
        duration: performance.now() - startPerf,
        usage,
        error,
      };

      this.aggregateUsage(this.usage, usage);

      this.emit("supervisor.classifier.failed", { error });

      throw error;
    }

    // Refine pass — optional. Refine receives the classifier output
    // on `ctx.result.data` plus `run` / `stream` for inline secondary
    // classifiers. Returns: undefined (use as-is) | END (halt) |
    // { intent?, ...slice } (override + merge).
    const refineHook = this.resolveRefineHook(config);
    let final: ClassifierOutput = raw;
    let refined = false;
    let halted = false;

    if (refineHook) {
      let refineResult: ClassifierRefineResult;

      try {
        refineResult = await refineHook(this.buildClassifierRefineContext(ctx, raw));
      } catch (thrown) {
        const error = toAIError(thrown);

        this.classifierSnapshot = {
          intent: undefined,
          refined: false,
          halted: true,
          raw,
          startedAt: startedAtIso,
          endedAt: new Date().toISOString(),
          duration: performance.now() - startPerf,
          usage,
          error,
        };

        this.aggregateUsage(this.usage, usage);

        this.emit("supervisor.classifier.failed", { error });

        throw error;
      }

      const interpretation = this.interpretRefineResult(refineResult, raw);

      if (interpretation.error) {
        this.classifierSnapshot = {
          intent: undefined,
          refined: true,
          halted: true,
          raw,
          startedAt: startedAtIso,
          endedAt: new Date().toISOString(),
          duration: performance.now() - startPerf,
          usage,
          error: interpretation.error,
        };

        this.aggregateUsage(this.usage, usage);

        this.emit("supervisor.classifier.failed", { error: interpretation.error });

        throw interpretation.error;
      }

      refined = interpretation.refined;
      halted = interpretation.halted;
      final = interpretation.final ?? raw;

      // Merge refine's slice into state BEFORE dispatching — refine
      // can augment state (e.g. detected language) regardless of
      // override-vs-keep decision.
      if (interpretation.sliceToMerge) {
        for (const [key, value] of Object.entries(interpretation.sliceToMerge)) {
          this.state[key] = value;
        }
      }
    }

    // Always merge the (possibly refined) classifier output's
    // remaining fields into state — universal locked fields (intent,
    // reasoning, confidence) plus any dev-extended fields. Subject
    // to the supervisor's `output` schema validation at finalize.
    for (const [key, value] of Object.entries(final)) {
      this.state[key] = value;
    }

    this.classifierSnapshot = {
      intent: halted ? undefined : final.intent,
      reasoning: final.reasoning,
      confidence: final.confidence,
      refined,
      halted,
      raw,
      startedAt: startedAtIso,
      endedAt: new Date().toISOString(),
      duration: performance.now() - startPerf,
      usage,
    };

    this.aggregateUsage(this.usage, usage);

    this.emit("supervisor.classifier.completed", {
      output: {
        intent: this.classifierSnapshot.intent,
        reasoning: this.classifierSnapshot.reasoning,
        confidence: this.classifierSnapshot.confidence,
      },
      intent: this.classifierSnapshot.intent,
      refined,
      halted,
      duration: this.classifierSnapshot.duration,
      usage,
    });

    if (halted) {
      this.classifierHalted = true;

      return;
    }

    // Validate the FINAL intent against the registry — refine may
    // have overridden to an unknown name. Throw loudly.
    if (!this.entries.has(final.intent)) {
      const error = new SupervisorFailedError(
        `ai.supervisor("${this.config.name}"): classifier.refine returned unknown intent "${final.intent}" — must be a key in \`intents\``,
        { context: { iteration: 0, available: [...this.entries.keys()] } },
        "SUPERVISOR_INVALID_ROUTE",
      );

      this.classifierSnapshot = { ...this.classifierSnapshot, halted: true, error };
      this.classifierHalted = true;

      this.emit("supervisor.classifier.failed", { error });

      throw error;
    }

    this.carriedClassifierDispatch = { intent: final.intent };
  }

  /**
   * Resolve the configured classifier into a callable that returns
   * `{ output, usage }`. Handles the four accepted shapes — bare
   * agent / bare callback / agent-entry / run-entry. Pure shape
   * normalization; no side effects.
   */
  private async invokeClassifier(
    config: ClassifierConfig,
    ctx: ClassifierContext,
  ): Promise<{ output: ClassifierOutput; usage: Usage }> {
    // (a) Bare callback shorthand.
    if (typeof config === "function") {
      const output = await (
        config as (ctx: ClassifierContext) => Promise<ClassifierOutput> | ClassifierOutput
      )(ctx);

      return { output, usage: { input: 0, output: 0, total: 0 } };
    }

    // (b) Run-entry — `{ run, refine? }`.
    if (typeof (config as { run?: unknown }).run === "function") {
      const runFn = (
        config as { run: (ctx: ClassifierContext) => Promise<ClassifierOutput> | ClassifierOutput }
      ).run;
      const output = await runFn(ctx);

      return { output, usage: { input: 0, output: 0, total: 0 } };
    }

    // (c) Agent-entry — `{ agent, placeholders?, input?, history?, refine? }`.
    if (typeof (config as { agent?: { execute?: unknown } }).agent?.execute === "function") {
      const entry = config as {
        agent: AgentContract<unknown>;
        placeholders?: (ctx: ClassifierContext) => Record<string, unknown>;
        input?: (ctx: ClassifierContext) => string;
        history?: (ctx: ClassifierContext) => Message[] | ReadonlyArray<Message>;
      };

      return this.invokeClassifierAgent(
        entry.agent,
        ctx,
        entry.placeholders,
        entry.input,
        entry.history,
      );
    }

    // (d) Bare agent shorthand.
    if (typeof (config as { execute?: unknown }).execute === "function") {
      return this.invokeClassifierAgent(config as AgentContract<unknown>, ctx);
    }

    throw new SupervisorFailedError(
      `ai.supervisor("${this.config.name}"): \`classifier\` is not an agent, callback, or entry object`,
      { context: { authoring: true } },
    );
  }

  /**
   * Invoke a classifier agent with the supervisor's standard wiring
   * — placeholders, input override, history slicing, signal,
   * streaming bubble. Output schema validation belongs to the agent
   * itself; we just pull the typed `data` (or fall back to parsing
   * `text`) and assert the locked `intent` field.
   */
  private async invokeClassifierAgent(
    agent: AgentContract<unknown>,
    ctx: ClassifierContext,
    placeholders?: (ctx: ClassifierContext) => Record<string, unknown>,
    inputResolver?: (ctx: ClassifierContext) => string,
    historySlicer?: (ctx: ClassifierContext) => Message[] | ReadonlyArray<Message>,
  ): Promise<{ output: ClassifierOutput; usage: Usage }> {
    const inputForAgent =
      inputResolver?.(ctx) ??
      (typeof ctx.input === "string" ? ctx.input : safeStringify(ctx.input));

    const history = historySlicer ? [...historySlicer(ctx)] : this.applyAgentsWindow();

    const isStreaming = this.streamController !== undefined;

    const handlers = {
      "agent.trip.streaming": ({ delta }: { delta: string }) => {
        this.emit("supervisor.classifier.streaming", { delta });
      },
    };

    const agentOptions = {
      signal: this.options?.signal,
      on: handlers,
      ...(placeholders ? { placeholders: placeholders(ctx) } : {}),
      ...(history.length > 0 ? { history } : {}),
    };

    let result: AgentResult<unknown>;

    if (isStreaming) {
      result = await agent.stream(inputForAgent, agentOptions).result;
    } else {
      result = await agent.execute(inputForAgent, agentOptions);
    }

    if (result.error) {
      throw result.error;
    }

    if (result.report) {
      this.childReports.push(result.report);
    }

    const data = result.data ?? result.text ?? undefined;
    const output = this.coerceClassifierOutput(data);

    return { output, usage: result.usage };
  }

  /**
   * Coerce an agent's output into the locked classifier shape.
   * Accepts a typed object with `intent` (the canonical case) or a
   * plain string (interpreted as the intent name with no reasoning).
   * Throws `SupervisorFailedError` if neither shape matches.
   */
  private coerceClassifierOutput(data: unknown): ClassifierOutput {
    if (typeof data === "string") {
      return { intent: data };
    }

    if (
      data &&
      typeof data === "object" &&
      typeof (data as { intent?: unknown }).intent === "string"
    ) {
      const record = data as Record<string, unknown>;

      return {
        intent: record.intent as string,
        reasoning: typeof record.reasoning === "string" ? (record.reasoning as string) : undefined,
        confidence:
          typeof record.confidence === "number" ? (record.confidence as number) : undefined,
      };
    }

    throw new SupervisorFailedError(
      `ai.supervisor("${this.config.name}"): classifier output missing required \`intent\` field — got ${JSON.stringify(data)?.slice(0, 200)}`,
      { context: { iteration: 0 } },
    );
  }

  /**
   * Build the read-only context passed to a classifier callback / agent
   * resolvers. No dispatch helpers — registered intents haven't fired
   * yet; pre-running them from the classifier would be confusing.
   */
  private buildClassifierContext(): ClassifierContext {
    return {
      iteration: 0,
      input: this.input,
      state: this.state,
      context: this.context,
      history: this.history,
      signal: this.options?.signal ?? new AbortController().signal,
      goal: this.goal,
    };
  }

  /**
   * Build the refine context — extends ClassifierContext with the
   * classifier's just-resolved output plus `run` / `stream` so the
   * refine hook can spin up secondary classifiers / validators
   * inline (Phase 6 features).
   */
  private buildClassifierRefineContext(
    base: ClassifierContext,
    raw: ClassifierOutput,
  ): ClassifierRefineContext {
    const callStack = new Set<string>();
    const reportSink = this.childReports;

    return {
      ...base,
      result: { data: raw },
      run: (executable, runInput, runOptions) =>
        this.runInline(executable, runInput, runOptions, callStack, reportSink),
      stream: (executable, runInput, runOptions) =>
        this.streamInline(executable, runInput, runOptions, callStack, reportSink, "classifier"),
    };
  }

  /**
   * Pull the optional `refine` hook off whichever classifier-config
   * shape was supplied. Bare-callback and bare-agent forms have no
   * refine; only entry forms do.
   */
  private resolveRefineHook(
    config: ClassifierConfig,
  ):
    | ((ctx: ClassifierRefineContext) => Promise<ClassifierRefineResult> | ClassifierRefineResult)
    | undefined {
    if (typeof config === "function") {
      return undefined;
    }

    const refine = (config as { refine?: unknown }).refine;

    return typeof refine === "function"
      ? (refine as (
          ctx: ClassifierRefineContext,
        ) => Promise<ClassifierRefineResult> | ClassifierRefineResult)
      : undefined;
  }

  /**
   * Interpret a refine return value into actionable bits — final
   * classifier output to dispatch, slice-to-merge, halted/refined
   * flags, or an error. See {@link ClassifierRefineResult} for the
   * accepted shapes.
   */
  private interpretRefineResult(
    refineResult: ClassifierRefineResult,
    raw: ClassifierOutput,
  ): {
    final?: ClassifierOutput;
    sliceToMerge?: Record<string, unknown>;
    refined: boolean;
    halted: boolean;
    error?: AIError;
  } {
    if (refineResult === undefined) {
      return { final: raw, refined: false, halted: false };
    }

    if (refineResult === END) {
      return { refined: true, halted: true };
    }

    if (typeof refineResult !== "object" || refineResult === null) {
      return {
        refined: false,
        halted: true,
        error: new SupervisorFailedError(
          `ai.supervisor("${this.config.name}"): classifier.refine returned an unsupported value — expected undefined, END, or an object`,
          { context: { iteration: 0 } },
        ),
      };
    }

    const record = refineResult as Record<string, unknown>;
    const intentField = record.intent;
    const halted = intentField === END;
    const intentOverride = typeof intentField === "string" ? intentField : undefined;

    // Slice-to-merge is the refine return MINUS the `intent` field
    // (which is dispatch metadata, not state contribution).
    const slice: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(record)) {
      if (key === "intent") continue;

      slice[key] = value;
    }

    const final: ClassifierOutput = {
      ...raw,
      ...(intentOverride ? { intent: intentOverride } : {}),
    };

    return {
      final: halted ? undefined : final,
      sliceToMerge: Object.keys(slice).length > 0 ? slice : undefined,
      refined: true,
      halted,
    };
  }

  /**
   * Run the `evaluate` callback (when configured) after the
   * iteration's branches settle and outputs have merged into state.
   * Errors in the callback surface as `SupervisorFailedError` so a
   * buggy evaluate doesn't silently swallow the whole run.
   *
   * Phase 3.4 (Stage 4b) — `EvaluateContext.state` carries the
   * post-merge accumulator so verdicts can be state-aware. Q9
   * lifted the router-only restriction; evaluate now runs in both
   * router and route modes.
   */
  private async runEvaluate(branches: AgentBranchSnapshot[]): Promise<EvaluateResult> {
    if (!this.config.evaluate) {
      return undefined;
    }

    const evaluateContext: EvaluateContext = {
      iteration: this.iteration,
      input: this.input,
      state: this.state,
      result: indexBranchesForEvaluate(branches),
      iterations: this.snapshots,
      context: this.context,
      history: this.history,
      goal: this.goal,
      classifier: this.classifierSnapshot,
    };

    try {
      return await (
        this.config.evaluate as (ctx: EvaluateContext) => EvaluateResult | Promise<EvaluateResult>
      )(evaluateContext);
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);

      throw new SupervisorFailedError(`evaluate callback threw: ${message}`, {
        cause: thrown,
      });
    }
  }

  /**
   * Merge each branch's output into supervisor `state` in
   * `decision.intents` order — Q15 conflict rule: last intent in
   * the array wins on key collisions. Errored branches don't
   * contribute. Non-object outputs (primitives, null) are skipped
   * with a warning log; they can't shallow-merge into an object.
   *
   * For agent/workflow intents: merging is opt-in via declaring an
   * `output` schema (the strip-merge gate). Without a schema, the
   * raw output stays on the branch snapshot but doesn't pollute
   * state. For callback intents: their return is already strip-merged
   * (or pass-through) inside `runCallback` — we just merge what's on
   * the branch snapshot.
   */
  private mergeBranchesIntoState(intentsOrder: string[], branches: AgentBranchSnapshot[]): void {
    const indexed = new Map<string, AgentBranchSnapshot>();
    for (const branch of branches) {
      indexed.set(branch.intent, branch);
    }

    const mergedKeys = new Map<string, string>();

    for (const intent of intentsOrder) {
      const branch = indexed.get(intent);
      if (!branch || branch.error) continue;

      const entry = this.entries.get(intent);

      // For agent/workflow intents, only merge when the slice schema
      // was declared (output present on the entry). For callbacks,
      // their output is always merged (the schema, if any, was
      // applied inside runCallback). Stream-mode agents (Phase 5 /
      // decisions §34) merge unconditionally — `applyOutputSchema`
      // already shaped their slice as `{ [streamTo]: text }`, and
      // they have no `output` schema by construction.
      const isStreamModeAgent = entry?.type === "agent" && entry.mode === "stream";
      const shouldMerge =
        entry?.type === "callback" || (entry && entry.output !== undefined) || isStreamModeAgent;

      if (!shouldMerge) continue;

      const slice = branch.output;

      if (!slice || typeof slice !== "object" || Array.isArray(slice)) {
        if (slice !== undefined) {
          this.logger.warn(
            this.logModule,
            "state.merge.skip",
            `intent "${intent}" output is not a mergeable object — skipping state merge`,
            { intent, type: typeof slice },
          );
        }
        continue;
      }

      for (const [key, value] of Object.entries(slice as Record<string, unknown>)) {
        const previousOwner = mergedKeys.get(key);
        if (previousOwner !== undefined && previousOwner !== intent) {
          this.logger.warn(
            this.logModule,
            "state.merge.conflict",
            `state key "${key}" written by both "${previousOwner}" and "${intent}" — last-in-decision-array wins (Q15)`,
            { key, previousOwner, currentIntent: intent },
          );
        }
        this.state[key] = value;
        mergedKeys.set(key, intent);
      }
    }
  }

  /**
   * Merge the iteration's accumulated `currentArtifacts` bag into
   * supervisor state (Phase 5 / decisions §35). Runs once per
   * iteration after branch slices land and before evaluate.
   *
   * Order of operations:
   *
   * 1. **Empty-bag fast path** — if no tool wrote anything, skip
   *    validation and merge entirely; reset the bag for the next
   *    iteration is also a no-op (already empty).
   * 2. **Schema validation** — when `config.artifactsSchema` is set,
   *    validate the bag against it. Failure aborts the iteration via
   *    a thrown `SchemaValidationError`; the iteration loop's outer
   *    catch surfaces it on `result.error`. Validation is opt-in
   *    (no schema → no validation cost).
   * 3. **Merge** — `config.finalizeArtifacts` when supplied, else
   *    auto-spread `state = { ...state, ...artifacts }`. Replace
   *    semantics under auto-spread; `finalizeArtifacts` carries
   *    full responsibility for concat / dedupe / cross-iteration
   *    accumulation when configured.
   * 4. **Reset** — `currentArtifacts = {}`. The next iteration's
   *    tool calls start with a fresh empty bag; long runs never
   *    accumulate raw artifacts here.
   */
  private async mergeArtifactsIntoState(): Promise<void> {
    const artifacts = this.currentArtifacts;
    const keys = Object.keys(artifacts);

    // Phase 8 / decisions §38 — capture the raw bag BEFORE validation
    // or merge so the iteration snapshot surfaces what the tools
    // actually wrote, regardless of what `finalizeArtifacts` did with
    // it. Frozen — consumers should never mutate forensic data.
    // Always run, even on empty bags — snapshot builder reads
    // `capturedIterationArtifacts` regardless.
    this.capturedIterationArtifacts = Object.freeze({ ...artifacts });

    if (keys.length === 0) {
      return;
    }

    const schema = this.config.artifactsSchema;

    if (schema) {
      const validation = await schema["~standard"].validate(artifacts);

      if (validation.issues) {
        throw new SchemaValidationError(
          `supervisor "${this.config.name}": iteration ${this.iteration} artifacts failed validation: ${validation.issues
            .map((issue) => issue.message)
            .join("; ")}`,
          { issues: validation.issues, context: { iteration: this.iteration } },
        );
      }
    }

    const finalize = this.config.finalizeArtifacts as
      | ((
          state: Record<string, unknown>,
          artifacts: Record<string, unknown>,
        ) => Record<string, unknown>)
      | undefined;

    if (finalize) {
      const merged = finalize(this.state, artifacts);

      // Mutate in place so external references to `this.state`
      // (snapshot copies, evaluate ctx) stay coherent. Drop keys
      // the finalize callback removed; overwrite the rest.
      for (const key of Object.keys(this.state)) {
        if (!(key in merged)) {
          delete this.state[key];
        }
      }

      for (const [key, value] of Object.entries(merged)) {
        this.state[key] = value;
      }
    } else {
      for (const [key, value] of Object.entries(artifacts)) {
        this.state[key] = value;
      }
    }

    this.currentArtifacts = {};
  }

  /**
   * Collect each branch's `intent.next(ctx)` directive after state
   * merge (Stage 4d / Q24). Iterates `decision.intents` order so
   * union resolution is deterministic.
   *
   * Rules:
   * - Errored branch → silent (treated as if no `next` defined).
   * - Branch with no `next` → silent; abstains (does NOT drag the
   *   iteration to the router).
   * - Branch returns `END` → supreme; terminates immediately and
   *   discards other branches' opinions.
   * - Branch returns `string` or `string[]` → contributes to the
   *   union of unique intent names. Validated against the
   *   supervisor's registry; unknown keys throw `SupervisorFailedError`.
   * - All branches silent → returns `undefined`; caller falls back
   *   to router/route.
   */
  private collectIntentNext(
    intentsOrder: string[],
    branches: AgentBranchSnapshot[],
  ): { kind: "dispatch"; intents: string[] } | { kind: "end" } | undefined {
    const indexed = new Map<string, AgentBranchSnapshot>();
    for (const branch of branches) {
      indexed.set(branch.intent, branch);
    }

    const collected: string[] = [];
    const seen = new Set<string>();
    let anySilent = false;

    for (const intent of intentsOrder) {
      const branch = indexed.get(intent);
      if (!branch || branch.error) {
        anySilent = true;
        continue;
      }

      const entry = this.entries.get(intent);
      if (!entry?.next) {
        anySilent = true;
        continue;
      }

      // Build a per-branch DispatchContext for the resolver. Cycle
      // stack is fresh-and-self-seeded so a `next` that calls
      // `ctx.intents.X.execute()` reuses the per-iteration cycle
      // detection mechanic.
      const dispatchCtx = this.seedDispatchContext(
        intent,
        branch.input,
        new Set<string>([intent]),
        [],
      );

      let raw: string | string[] | typeof END | undefined;
      try {
        raw = entry.next(dispatchCtx) as string | string[] | typeof END | undefined;
      } catch (thrown) {
        const message = thrown instanceof Error ? thrown.message : String(thrown);
        throw new SupervisorFailedError(`intent "${intent}" \`next\` resolver threw: ${message}`, {
          cause: thrown,
          context: { intent },
        });
      }

      if (raw === undefined) {
        anySilent = true;
        continue;
      }

      if (raw === END) {
        return { kind: "end" };
      }

      const proposed = Array.isArray(raw) ? raw : [raw];

      for (const target of proposed) {
        if (typeof target !== "string") {
          throw new SupervisorFailedError(
            `intent "${intent}" \`next\` returned a non-string value`,
            { context: { intent } },
          );
        }

        if (!this.entries.has(target)) {
          throw new SupervisorFailedError(
            `intent "${intent}" \`next\` returned unknown intent "${target}"`,
            {
              context: { intent, target, available: [...this.entries.keys()] },
            },
          );
        }

        if (!seen.has(target)) {
          seen.add(target);
          collected.push(target);
        }
      }
    }

    void anySilent;

    if (collected.length === 0) {
      // No branch directed the next iteration — fall back to router.
      return undefined;
    }

    return { kind: "dispatch", intents: collected };
  }

  /**
   * Finalize the supervisor result: validate accumulated state
   * against the output schema and build the public `SupervisorResult`.
   * Assemble-only — event emission and stream close happen in
   * `run()` around this call.
   */
  private async finalize(): Promise<SupervisorResult<TOutput>> {
    if (this.status === "completed" && !this.error) {
      try {
        this.data = await this.buildTypedData();
      } catch (thrown) {
        this.error = toAIError(thrown);
        this.status = "failed";
        this.terminatedBy = "error";
      }
    }

    const endedAt = new Date();

    // `max-iterations` and the orchestrator-only `awaiting-input` are
    // members of the shared `ReportStatus` union but not of the narrower
    // `SupervisorSnapshotStatus`. A supervisor never reaches
    // `awaiting-input` at runtime; both collapse to the existing
    // `failed` fallback here so the snapshot status stays representable.
    const finalStatus: SupervisorSnapshotStatus =
      this.status === "max-iterations" || this.status === "awaiting-input"
        ? "failed"
        : this.status;

    await this.checkpoint(finalStatus);

    const report: SupervisorReport = {
      runId: this.runId,
      rootRunId: this.runId,
      name: this.config.name,
      version: this.config.version,
      type: "supervisor",
      supervisorName: this.config.name,
      signature: this.signature,
      status: this.status,
      terminatedBy: this.terminatedBy,
      iterations: this.snapshots.length,
      startedAt: this.startedAtIso,
      endedAt: endedAt.toISOString(),
      duration: performance.now() - this.startPerf,
      cancelledAt: this.cancelledAtIso,
      usage: this.usage,
      children: this.childReports,
      snapshots: this.snapshots,
      ack: this.ackSnapshot,
      classifier: this.classifierSnapshot,
    };

    // Stamp lineage on the assembled tree exactly once per run.
    // Walker rewrites inner self-roots from every nested agent /
    // workflow / callback report the supervisor absorbed, propagates
    // sessionId, and writes `reportSchemaVersion` on the root.
    stampReportLineage(report, {
      rootRunId: this.runId,
      sessionId: this.options?.sessionId,
    });

    return {
      type: "supervisor",
      data: this.data,
      report,
      usage: this.usage,
      error: this.error,
    };
  }

  /**
   * Build the typed `data` at finalize. Stage 4c — single mode:
   *
   * - When `config.output` is declared, validate the accumulated
   *   `state` against it and return the validated value (Q8).
   *   `result.data` always matches the schema, or `result.error`
   *   carries the validation issues.
   * - When `config.output` is omitted, return the raw state object.
   *
   * Validation failure surfaces as `SchemaValidationError` on
   * `result.error`; the run is still considered semantically
   * "completed" (intents ran, evaluate said done) but the typed
   * data slot is empty.
   */
  private async buildTypedData(): Promise<TOutput | undefined> {
    if (this.config.output) {
      return validateOutput<TOutput>(this.config.output, this.state as unknown);
    }

    return this.state as TOutput;
  }

  /**
   * Record a snapshot for an iteration whose first decision was
   * `END` — no dispatch, no evaluate, just the decision record. Keeps
   * the snapshot log uniform so a late-route-to-END still appears in
   * the forensic history rather than vanishing.
   */
  private async recordTerminalDecisionSnapshot(
    decision: DispatchDecision & { kind: "end" },
    iterationStartedAt: Date,
    iterationStart: number,
    iterationUsage: Usage,
  ): Promise<void> {
    const snapshot: IterationSnapshot = Object.freeze({
      iteration: this.iteration,
      result: {},
      decision: {
        source: decision.source,
        next: decision.raw,
        reasoning: decision.reasoning,
        durationMs: decision.durationMs,
      },
      state: { ...this.state },
      artifacts: this.capturedIterationArtifacts,
      startedAt: iterationStartedAt.toISOString(),
      endedAt: new Date().toISOString(),
      duration: performance.now() - iterationStart,
      usage: iterationUsage,
    });

    this.snapshots.push(snapshot);

    this.emit("supervisor.iteration.completed", {
      iteration: this.iteration,
      snapshot,
    });

    await this.checkpoint("running");
  }

  /**
   * Write the current run state to the configured KV store (if any).
   * Persistence failures surface as `supervisor.error` events and
   * logged warnings but never abort the run — checkpoint best-effort
   * by design, matching `workflow` semantics.
   */
  private async checkpoint(status: SupervisorSnapshotStatus): Promise<void> {
    const outcome = await persistSupervisorSnapshot({
      config: this.config as SupervisorConfig<unknown>,
      signature: this.signature,
      runId: this.runId,
      input: this.input,
      startedAt: this.startedAtIso,
      iteration: this.snapshots.length - 1,
      snapshots: this.snapshots,
      status,
    });

    if (!outcome.ok) {
      this.logger.warn(this.logModule, "persist.failed", "snapshot persist failed", {
        runId: this.runId,
      });
    }
  }

  /**
   * Between-iteration cancellation check. Called at the top of
   * every iteration; signal abort here means the loop exits before
   * any routing happens.
   */
  private throwIfCancelled(): void {
    if (this.options?.signal?.aborted) {
      throw createCancelledError(this.options.signal);
    }
  }

  /**
   * Aggregate one usage record (typically a branch or a router call)
   * into both the run-wide total and the iteration-local total.
   */
  private aggregateUsage(iterationUsage: Usage, partial?: Usage): void {
    if (!partial) {
      return;
    }

    this.usage.input += partial.input;
    this.usage.output += partial.output;
    this.usage.total += partial.total;

    iterationUsage.input += partial.input;
    iterationUsage.output += partial.output;
    iterationUsage.total += partial.total;
  }

  /**
   * Fan an event out through the three-tier emitter AND mirror it
   * into the stream controller when streaming. Event names map 1:1
   * to stream event types so consumers iterating the stream see the
   * exact same surface as `.on()` / `options.on` handlers.
   */
  private emit<K extends keyof SupervisorEventMap>(
    event: K,
    payload: WithoutIdentity<SupervisorEventMap[K]>,
  ): void {
    // Inject run identity once, here, so the three-tier emitter, the
    // structured log line, and the stream all see it. `rootRunId ===
    // runId` for a standalone run; nested propagation is a follow-up.
    const identity: EventIdentity = {
      runId: this.runId,
      rootRunId: this.runId,
    };

    const fullPayload = { ...payload, ...identity } as SupervisorEventMap[K];

    this.emitter.emit(event, fullPayload, this.options?.on);
    this.logEvent(event, fullPayload);

    if (this.streamController) {
      this.streamController.push({
        type: event,
        ...(fullPayload as object),
      } as SupervisorStreamEvent);
    }
  }

  private logEvent<K extends keyof import("../contracts/events/event-map.type").SupervisorEventMap>(
    event: K,
    payload: import("../contracts/events/event-map.type").SupervisorEventMap[K],
  ): void {
    const action = event.replace(/^supervisor\./, "");

    switch (event) {
      case "supervisor.starting":
        this.logger.info(this.logModule, action, "supervisor starting", {
          runId: this.runId,
        });
        return;

      case "supervisor.iteration.starting":
        this.logger.debug(this.logModule, action, "iteration starting", {
          iteration: (payload as { iteration: number }).iteration,
        });
        return;

      case "supervisor.router.decided":
        this.logger.debug(this.logModule, action, "router decided", {
          iteration: (payload as { iteration: number }).iteration,
          next: (payload as { next: unknown }).next,
        });
        return;

      case "supervisor.agent.completed": {
        const typed = payload as {
          intent: string;
          duration: number;
          usage: Usage;
        };
        this.logger.success(this.logModule, action, `branch "${typed.intent}" done`, {
          duration: typed.duration,
          usage: typed.usage,
        });
        return;
      }

      case "supervisor.agent.failed": {
        const typed = payload as { intent: string; error: AIError };
        this.logger.warn(this.logModule, action, `branch "${typed.intent}" failed`, {
          code: typed.error.code,
          message: typed.error.message,
        });
        return;
      }

      case "supervisor.error": {
        const { error } = payload as { error: AIError };
        this.logger.error(this.logModule, action, error.message, {
          code: error.code,
        });
        return;
      }

      case "supervisor.cancelled": {
        const typed = payload as { cancelledAt: string; reason?: string };
        this.logger.warn(this.logModule, action, "supervisor cancelled", {
          cancelledAt: typed.cancelledAt,
          reason: typed.reason,
        });
        return;
      }

      case "supervisor.iteration.completed":
        this.logger.debug(this.logModule, action, "iteration completed", {
          iteration: (payload as { iteration: number }).iteration,
        });
        return;

      default:
        // Streaming / per-branch starting events are high-volume — no
        // dedicated log line.
        return;
    }
  }
}

function indexByIntent(branches: AgentBranchSnapshot[]): Record<string, AgentBranchSnapshot> {
  const indexed: Record<string, AgentBranchSnapshot> = {};

  for (const branch of branches) {
    indexed[branch.intent] = branch;
  }

  return indexed;
}

function indexBranchesForEvaluate(
  branches: AgentBranchSnapshot[],
): Record<string, EvaluateBranchResult> {
  const indexed: Record<string, EvaluateBranchResult> = {};

  for (const branch of branches) {
    indexed[branch.intent] = {
      output: branch.output,
      input: branch.input,
      usage: branch.usage,
      durationMs: branch.duration,
      error: branch.error,
    };
  }

  return indexed;
}

function normalizeReassign(reassignTo: string | string[] | undefined): string[] {
  if (!reassignTo) {
    return [];
  }

  if (Array.isArray(reassignTo)) {
    return reassignTo;
  }

  return [reassignTo];
}

function toAIError(thrown: unknown): AIError {
  if (thrown instanceof AIError) {
    return thrown;
  }

  const message = thrown instanceof Error ? thrown.message : String(thrown);

  return new SupervisorFailedError(message, { cause: thrown });
}

/**
 * Sum a list of child `BaseReport.usage` values. Callbacks
 * themselves contribute zero own-cost (they're dev code, not LLM
 * calls); their report's `usage` equals the sum of whatever
 * agents / workflows / nested callbacks they dispatched via
 * `ctx.intents.X.execute()`. Mirrors `compositeAsTool` semantics.
 */
function aggregateChildUsage(children: BaseReport[]): Usage {
  return children.reduce<Usage>(
    (acc, child) => ({
      input: acc.input + child.usage.input,
      output: acc.output + child.usage.output,
      total: acc.total + child.usage.total,
    }),
    { input: 0, output: 0, total: 0 },
  );
}

/**
 * Best-effort stringification for the snapshot's `input` field when
 * a callback intent's resolved input is a non-string value. Falls
 * back to a typed placeholder if `JSON.stringify` throws (circular
 * refs, BigInt, etc.) so a snapshot write never fails on its own.
 */
function safeStringify(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return `[unserializable: ${typeof value}]`;
  }
}

async function validateOutput<TOutput>(
  schema: StandardSchemaV1<TOutput>,
  value: unknown,
): Promise<TOutput> {
  const validation = await schema["~standard"].validate(value);

  if (validation.issues) {
    throw new SchemaValidationError(validation.issues.map((issue) => issue.message).join("; "), {
      issues: validation.issues,
    });
  }

  return validation.value;
}
