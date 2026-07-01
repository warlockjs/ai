import type { StandardSchemaV1 } from "@standard-schema/spec";
import { log } from "@warlock.js/logger";
import type { AgentContract } from "../contracts/agent/agent.contract";
import type { PlannerCapability } from "../contracts/planner/planner-capability.type";
import type { PlannerConfig } from "../contracts/planner/planner-config.type";
import type {
  PlannerExecuteOptions,
  PlannerStepDirective,
} from "../contracts/planner/planner-execute-options.type";
import type { PlannerPlan, PlannerStep } from "../contracts/planner/planner-plan.type";
import type {
  PlannerReport,
  PlannerResult,
  PlannerStepSnapshot,
} from "../contracts/planner/planner-result.type";
import type {
  PlannerSnapshot,
  PlannerSnapshotStatus,
} from "../contracts/planner/planner-snapshot.type";
import type { BaseReport } from "../contracts/result/base-report.type";
import { REPORT_SCHEMA_VERSION } from "../contracts/result/base-report.type";
import type { BaseResult } from "../contracts/result/base-result.type";
import type { Usage } from "../contracts/result/usage.type";
import { AIError } from "../errors/ai-error";
import { PlannerCancelledError } from "../errors/planner-cancelled-error";
import { PlannerFailedError } from "../errors/planner-failed-error";
import { PlannerPlanInvalidError } from "../errors/planner-plan-invalid-error";
import { SchemaValidationError } from "../errors/schema-validation-error";
import { notifyObservers } from "../observe/resolve-observers";
import { accumulateCost } from "../utils/compute-cost";
import { generateRunId } from "../utils/generate-run-id";
import { captureChildReport, withoutRunFrame } from "../utils/run-context";
import { stampReportLineage } from "../utils/stamp-report-lineage";
import type { DagNode, PlannerDag } from "./dag-scheduler";
import { buildDag, readyNodes, sinkNodes } from "./dag-scheduler";
import { planSchema } from "./plan-schema";
import {
  deletePlannerSnapshot,
  persistPlannerSnapshot,
} from "./snapshot";

/**
 * Construction args for one {@link PlannerRun}. Carries everything the
 * factory resolved once (config, capability map, signature, planning
 * agent) plus the per-call goal and options.
 */
export type PlannerRunArgs<TOutput> = {
  config: PlannerConfig<TOutput>;
  capabilities: Map<string, PlannerCapability>;
  maxSteps: number;
  signature: string;
  planningAgent: AgentContract<unknown>;
  goal: string;
  options?: PlannerExecuteOptions<TOutput>;
  /**
   * Durable resume seed. When present the run re-hydrates the frozen plan
   * + executed-node ledger + usage + child reports + replan budget from a
   * prior crash, skips plan generation, and continues scheduling only the
   * unfinished frontier. Absent ⇒ a normal cold run.
   */
  resumeFrom?: PlannerSnapshot;
};

/**
 * Per-call orchestration state for one `planner.execute()` invocation.
 *
 * **Role.** Owns the full bounded-v1 planning lifecycle across four
 * phases that share mutable accumulators: (1) ask the LLM to GENERATE a
 * plan, (2) execute each plan step through its capability's `execute()`,
 * (3) optionally validate the final output, (4) assemble the unified
 * {@link PlannerResult}. Instantiated fresh per call inside the factory
 * so the accumulators (`usage`, `children`, `executedSteps`) are never
 * shared across runs. Unexported — callers only ever see the plain
 * {@link PlannerResult}.
 *
 * **Composition, not a fork.** Plan generation runs through a normal
 * `agent.execute()`; each step runs through the capability's own
 * `executable.execute()`. The planner adds the plan-generation brain and
 * the ordered-dispatch loop on top of the existing executable machinery —
 * it does not reimplement agent or step internals.
 */
export class PlannerRun<TOutput> {
  private readonly runId: string;
  /**
   * Run start timestamp. A resumed run restores it from the snapshot (in
   * the constructor) so the rebuilt report spans the whole run, not just
   * the resumed tail — hence not `readonly`.
   */
  private startedAt = new Date().toISOString();
  private readonly startPerf = performance.now();

  private readonly usage: Usage = { input: 0, output: 0, total: 0 };
  private readonly children: BaseReport[] = [];
  private readonly executedSteps: PlannerStepSnapshot[] = [];

  private plan?: PlannerPlan;
  private data?: TOutput;
  private error?: AIError;
  private cancelledAt?: string;

  /** Set when `mode: "plan-only"` short-circuited before execution. */
  private awaitingApproval = false;

  /** How many times the plan has been regenerated mid-run (≤ maxReplans). */
  private replanCount = 0;

  /**
   * One-shot guard so the DAG resume re-seed runs only on the first
   * `executeDag` pass — a later replan recursion gets a fresh plan with
   * different node ids and must NOT re-seed against the stale ledger.
   */
  private dagResumeConsumed = false;

  public constructor(private readonly args: PlannerRunArgs<TOutput>) {
    // A resumed run reuses the snapshot's key so it writes back to the
    // same record; otherwise a caller-supplied `options.runId` wins, else
    // a fresh id is generated.
    this.runId = args.resumeFrom?.runId ?? args.options?.runId ?? generateRunId("planner");

    // Seed the accumulators from the snapshot on resume — re-hydrate the
    // frozen plan, the per-node ledger, the rolled-up usage, the child
    // reports, and the replan budget. `startedAt` restores too so the
    // resumed report spans the whole run. Pushing into the ledger rather
    // than re-running nodes is what keeps completed capabilities from
    // re-dispatching — the sequential guard / DAG re-seed read "what ran"
    // straight off `executedSteps`. Absent ⇒ accumulators stay empty and
    // the cold path is byte-for-byte unchanged.
    if (args.resumeFrom) {
      this.plan = args.resumeFrom.plan;
      this.executedSteps.push(...args.resumeFrom.executedSteps);
      this.children.push(...args.resumeFrom.children);
      this.mergeUsage(this.usage, args.resumeFrom.usage);
      this.replanCount = args.resumeFrom.replanCount;
      this.startedAt = args.resumeFrom.startedAt;
    }
  }

  /**
   * Run the planner end-to-end. Never throws on runtime failure —
   * generation errors, plan-validity errors, step failures, and
   * cancellation all surface on `result.error` with a narrowing
   * `report.status`.
   */
  public async run(): Promise<PlannerResult<TOutput>> {
    const result = await this.runPlan();

    // Route the planner's OWN report — the planning trip plus every
    // capability step already nest under it via `absorb`, so this single
    // call surfaces the whole tree as one trace. Mirrors agent/workflow:
    // `notifyObservers` self-routes a root run under observe-all (skipped
    // when nested, via the run-frame gate), then `captureChildReport`
    // auto-nests the planner under any enclosing orchestration run. Without
    // this, observe-all would only ever see the sub-agents as standalone
    // fragments — the planner itself never appeared.
    await notifyObservers(this.args.config.observe, result.report);
    captureChildReport(result.report);

    return result;
  }

  /**
   * Drive the planner lifecycle and return the built result WITHOUT
   * routing it — `run()` owns observer routing + auto-nesting so the
   * unified tree is emitted exactly once.
   */
  private async runPlan(): Promise<PlannerResult<TOutput>> {
    // Completed-run short-circuit. A resume of a snapshot whose run
    // already COMPLETED re-runs nothing — the stored ledger IS the
    // result. A `failed` / `cancelled` snapshot is NOT short-circuited:
    // those are the runs a caller resumes to retry the unfinished
    // frontier after fixing the cause, so they re-enter execution below.
    if (this.args.resumeFrom && this.args.resumeFrom.status === "completed") {
      this.rebuildResumedTerminal("completed");
      return this.buildResult();
    }

    try {
      if (this.isAborted()) {
        this.markCancelled();
        await this.checkpoint(this.resolveSnapshotStatus());
        return this.buildResult();
      }

      // Resume fork — the plan is frozen (re-asking the LLM would burn
      // tokens and risk a different plan that no longer matches the
      // executed-node ledger). Skip generation entirely and execute the
      // re-hydrated plan; the sequential guard / DAG re-seed skip the
      // nodes already terminal in `executedSteps`.
      const plan = this.args.resumeFrom
        ? (this.plan as PlannerPlan)
        : (this.args.options?.approvedPlan ?? (await this.generatePlan()));

      if (this.error || !plan) {
        await this.checkpoint(this.resolveSnapshotStatus());
        return this.buildResult();
      }

      // On a fresh run, validate the plan (a generated / approved plan
      // could name an unknown capability). A resumed plan was already
      // valid when persisted, so skip re-validation unless drift `force`
      // is implied — re-validating a frozen plan against the same live
      // capabilities is redundant.
      if (!this.args.resumeFrom) {
        this.assertPlanValid(plan);

        if (this.error) {
          await this.checkpoint(this.resolveSnapshotStatus());
          return this.buildResult();
        }
      }

      this.plan = plan;

      // Plan-only mode — surface the validated plan for sign-off and execute
      // NOTHING. `approvedPlan` overrides this (execute the supplied plan),
      // mirroring the documented "approvedPlan wins" precedence. A resume is
      // always an execution, never a plan-only short-circuit.
      if (
        !this.args.resumeFrom &&
        this.args.options?.mode === "plan-only" &&
        !this.args.options?.approvedPlan
      ) {
        this.awaitingApproval = true;
        return this.buildResult();
      }

      await this.executePlan(plan);

      await this.finalizeOutput();
    } catch (caught) {
      this.error = this.toAIError(caught);
    }

    // Terminal checkpoint — persist the final state so a completed-run
    // resume short-circuits, then optionally drop the snapshot when
    // `deleteOnComplete` is set and the run succeeded. No-op when
    // `durable` is absent.
    await this.checkpoint(this.resolveSnapshotStatus());

    if (!this.error && this.args.config.durable?.deleteOnComplete) {
      const outcome = await deletePlannerSnapshot({
        durable: this.args.config.durable,
        runId: this.runId,
      });

      if (!outcome.ok) {
        this.logDurableFailure("snapshot.delete.failed", outcome.error);
      }
    }

    return this.buildResult();
  }

  /**
   * Phase 1 — ask the planning agent for a structured plan. The plan
   * schema (built from the live capability names) is supplied as the
   * agent's per-call `output`, so the model is steered to reference only
   * real capabilities. The planning trip's usage + report roll into the
   * planner's totals regardless of outcome.
   *
   * `feedback` is set only on a RE-plan: the regenerated request is
   * seeded with the executed-step digest plus the caller's feedback so
   * the planner revises the remaining work rather than starting cold.
   */
  private async generatePlan(feedback?: string): Promise<PlannerPlan | undefined> {
    const schema = planSchema([...this.args.capabilities.keys()], this.args.maxSteps);

    // `withoutRunFrame` suppresses the planning trip's own self-routing:
    // `absorb` already folds its report into `this.children`, so without
    // this the trip would ALSO route as a standalone top-level trace under
    // observe-all. The planner routes the unified tree once, in `run()`.
    const result = await withoutRunFrame(() =>
      this.args.planningAgent.execute(this.buildPlanPrompt(feedback), {
        output: schema as StandardSchemaV1<unknown>,
        placeholders: this.args.options?.placeholders,
        signal: this.args.options?.signal,
        sessionId: this.args.options?.sessionId,
      }),
    );

    this.absorb(result.usage, result.report);

    if (result.error) {
      // A schema rejection from the planning trip (e.g. an empty
      // `steps` array tripping the plan schema) is really an invalid
      // plan — re-wrap it into the typed planner contract so callers
      // branch on `PlannerPlanInvalidError` rather than the agent's raw
      // `SchemaValidationError`. Any other child error flows through
      // unchanged.
      this.error =
        result.error instanceof SchemaValidationError
          ? new PlannerPlanInvalidError(
              `ai.planner("${this.args.config.name}"): the planner produced no usable plan`,
              { cause: result.error, context: { runId: this.runId } },
            )
          : result.error;
      return undefined;
    }

    const plan = result.data as PlannerPlan | undefined;

    if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
      this.error = new PlannerPlanInvalidError(
        `ai.planner("${this.args.config.name}"): the planner produced no usable plan`,
        { context: { runId: this.runId } },
      );
      return undefined;
    }

    this.assertPlanValid(plan);

    if (this.error) {
      return undefined;
    }

    return plan;
  }

  /**
   * Shared plan-validity guard — used both for a freshly generated plan
   * and for a caller-supplied `approvedPlan`. Sets `this.error` to a
   * typed {@link PlannerPlanInvalidError} when the plan is empty or names
   * an unknown capability; a stale `approvedPlan` thus fails the same way
   * a hallucinated capability does, never silently mis-dispatching.
   */
  private assertPlanValid(plan: PlannerPlan): void {
    if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
      this.error = new PlannerPlanInvalidError(
        `ai.planner("${this.args.config.name}"): the planner produced no usable plan`,
        { context: { runId: this.runId } },
      );
      return;
    }

    const unknownStep = plan.steps.find((step) => !this.args.capabilities.has(step.capability));

    if (unknownStep) {
      this.error = new PlannerPlanInvalidError(
        `ai.planner("${this.args.config.name}"): plan references unknown capability "${unknownStep.capability}"`,
        { context: { runId: this.runId, capability: unknownStep.capability } },
      );
    }
  }

  /**
   * Phase 2 — execute the plan. Branches on `config.dag`: the default is
   * the strict array-order sequential loop (byte-for-byte today's
   * behavior when neither `onStep` nor `replan` is configured); `dag:
   * true` schedules independent `dependsOn` branches in parallel.
   */
  private async executePlan(plan: PlannerPlan): Promise<void> {
    if (this.args.config.dag) {
      return this.executeDag(plan);
    }

    return this.executeSequential(plan);
  }

  /**
   * Sequential executor — the original strict array-order loop, threading
   * each completed step's output into the next step's input context.
   * Stops at the first step failure or when the abort signal fires
   * between steps; steps beyond `maxSteps` are recorded `skipped`.
   *
   * **Additive hooks (inert by default).** After each step settles it
   * fires the `onStep` directive hook; an `abort` directive stops the run
   * like a failure, and a `replan` directive (or, when `config.replan` is
   * set, an unhandled failure) regenerates the REMAINING plan instead of
   * aborting. With no `onStep` and no `replan`, the behavior is identical
   * to before.
   */
  private async executeSequential(plan: PlannerPlan): Promise<void> {
    const previousOutputs: string[] = [];
    let steps = plan.steps;
    let index = 0;

    // Resume re-seed (sequential). The frozen plan's already-completed
    // prefix lives in the persisted ledger; thread its outputs forward and
    // jump the cursor past it so completed nodes are never re-dispatched.
    // Stale non-completed entries (the failed node that crashed the run,
    // and any `skipped` tail) are pruned so the re-run repopulates them
    // cleanly instead of duplicating. No-op on a cold run (empty ledger).
    if (this.args.resumeFrom) {
      index = this.rehydrateSequentialState(steps, previousOutputs);
    }

    while (index < steps.length) {
      const step = steps[index] as PlannerStep;

      if (index >= this.args.maxSteps) {
        this.recordSkipped(index, step);
        index++;
        continue;
      }

      if (this.isAborted()) {
        this.markCancelled();
        this.recordSkipped(index, step);
        index++;
        continue;
      }

      const completed = await this.executeStep(index, step, previousOutputs);

      const snapshot = this.snapshotFor(index);
      const directive = snapshot
        ? await this.resolveDirective(snapshot, plan, completed)
        : undefined;

      if (directive?.type === "replan") {
        const remaining = await this.regeneratePlan(directive.feedback);

        if (this.error || !remaining) {
          this.skipRest(steps, index + 1);
          return;
        }

        // Replace the remaining tail with the regenerated plan and restart
        // the cursor against it (executed steps already recorded stay put).
        // Each new step gets the executed-so-far digest as its context.
        steps = remaining.steps;
        index = 0;
        previousOutputs.length = 0;
        previousOutputs.push(...this.executedDigest());
        continue;
      }

      if (directive?.type === "abort") {
        // The hook (or an unhandled failure) asked to stop — record the
        // remaining steps as skipped so the report still describes the
        // whole intended plan, then stop.
        this.skipRest(steps, index + 1);
        return;
      }

      index++;
    }
  }

  /**
   * DAG executor — schedule independent `dependsOn` branches in parallel.
   *
   * Builds the DAG (cycle / unknown-id → `PlannerPlanInvalidError`),
   * then repeatedly computes the ready set (steps whose deps all
   * completed), dispatches up to `maxConcurrency` of them with
   * `Promise.all`, and feeds each step ONLY its dependencies' outputs. A
   * failed step blocks just its descendants (recorded `skipped`);
   * independent branches still settle. With an `output` schema set, the
   * final `data` is the topological SINK's output (multiple sinks → a
   * convergence error).
   */
  private async executeDag(plan: PlannerPlan): Promise<void> {
    const dag = buildDag(plan.steps, this.args.config.name);
    const maxConcurrency = Math.max(1, this.args.config.maxConcurrency ?? 4);

    const completed = new Set<string>();
    const done = new Set<string>();
    const outputs = new Map<string, string>();
    const rawOutputs = new Map<string, unknown>();
    let executedCount = 0;

    // Resume re-seed (DAG). Re-derive the scheduler's working sets from
    // the persisted ledger so `readyNodes` schedules only the unfinished
    // frontier — completed nodes go straight into `completed` + `done`
    // with their outputs restored; stale non-completed entries are pruned
    // so the re-run repopulates them. One-shot: consumed on the first DAG
    // pass so a later replan recursion (fresh plan, different node ids)
    // doesn't re-seed against a stale ledger. No-op on a cold run.
    if (this.args.resumeFrom && !this.dagResumeConsumed) {
      this.dagResumeConsumed = true;
      executedCount = this.rehydrateDagState(dag, completed, done, outputs, rawOutputs);
    }

    while (done.size < dag.nodes.length) {
      if (this.isAborted()) {
        this.markCancelled();
        this.skipDagRest(dag, done);
        return;
      }

      const ready = readyNodes(dag, completed, done);

      if (ready.length === 0) {
        // No node can advance — every remaining node transitively depends
        // on a failed/skipped ancestor. Record them skipped and stop.
        this.skipDagRest(dag, done);
        return;
      }

      const batch = ready.slice(0, maxConcurrency);

      const settled = await Promise.all(
        batch.map(async (node) => {
          // `maxSteps` truncation applies to the count of DISPATCHED steps.
          if (executedCount >= this.args.maxSteps) {
            this.recordSkipped(node.index, node.step);
            return { node, ran: false, completed: false };
          }

          executedCount++;
          // Feed this step ONLY its dependencies' output digests — the DAG
          // fix for the sequential loop's "all prior outputs into every
          // step" behavior. `executeStep` pushes into the array it is
          // given, so a fresh array per node keeps branches isolated.
          const previousOutputs = node.dependencies.map(
            (dependency) => outputs.get(dependency) as string,
          );
          const stepCompleted = await this.executeStep(
            node.index,
            node.step,
            previousOutputs,
          );

          if (stepCompleted) {
            // Read the raw output off the snapshot (NOT shared `this.data`,
            // which races under Promise.all) for both the dependent digest
            // and the eventual sink output.
            const rawOutput = this.snapshotFor(node.index)?.output;
            rawOutputs.set(node.id, rawOutput);
            outputs.set(node.id, this.stringifyOutput(node.step.capability, rawOutput));
          }

          return { node, ran: true, completed: stepCompleted };
        }),
      );

      for (const entry of settled) {
        done.add(entry.node.id);

        if (entry.completed) {
          completed.add(entry.node.id);
        }
      }

      // Fire the per-step hook for each settled step (in dispatch order).
      let replanFeedback: string | undefined;
      let shouldAbort = false;

      for (const entry of settled) {
        if (!entry.ran) {
          continue;
        }

        const snapshot = this.snapshotFor(entry.node.index);
        const directive = snapshot
          ? await this.resolveDirective(snapshot, plan, entry.completed)
          : undefined;

        if (directive?.type === "replan") {
          replanFeedback = directive.feedback;
        } else if (directive?.type === "abort") {
          shouldAbort = true;
        }
      }

      if (shouldAbort) {
        this.skipDagRest(dag, done);
        return;
      }

      if (replanFeedback !== undefined) {
        const remaining = await this.regeneratePlan(replanFeedback);

        if (this.error || !remaining) {
          this.skipDagRest(dag, done);
          return;
        }

        // Re-plan in DAG mode regenerates the remaining work as a fresh
        // (sequential) plan and runs it through the DAG scheduler again.
        return this.executeDag(remaining);
      }
    }

    this.finalizeDagOutput(dag, completed, rawOutputs);
  }

  /**
   * Dispatch one plan step through its capability's `executable.execute()`
   * and fold the outcome into the accumulators. Returns `true` when the
   * step completed, `false` when it failed (setting the run error).
   */
  private async executeStep(
    index: number,
    step: PlannerStep,
    previousOutputs: string[],
  ): Promise<boolean> {
    const capability = this.args.capabilities.get(step.capability) as PlannerCapability;
    const stepStart = performance.now();
    const startedAt = new Date().toISOString();
    const input = this.composeStepInput(step, previousOutputs);

    // `withoutRunFrame` keeps each capability step nested under the planner
    // only — `absorb` folds its report into `this.children`, so suppressing
    // its self-route prevents a duplicate standalone trace under observe-all.
    const result = await withoutRunFrame(() =>
      capability.executable.execute(input, {
        signal: this.args.options?.signal,
        sessionId: this.args.options?.sessionId,
      }),
    );

    const childReport = "report" in result ? (result.report as BaseReport) : undefined;
    this.absorb(result.usage, childReport);

    const output = this.extractOutput(result);
    const failed = result.error !== undefined;

    this.executedSteps.push({
      index,
      step,
      status: failed ? "failed" : "completed",
      output: failed ? undefined : output,
      error: result.error,
      startedAt,
      endedAt: new Date().toISOString(),
      duration: performance.now() - stepStart,
      usage: result.usage,
      childReport,
    });

    // Per-node durable checkpoint. Sits AFTER the node's snapshot is
    // pushed and `absorb` has folded its usage + child report — the only
    // point where the ledger + usage + children are mutually consistent.
    // A completed node is never re-dispatched on resume (the sequential
    // guard / DAG re-seed skip it). Swallow-and-log; no-op when `durable`
    // is absent.
    await this.checkpoint("running");

    if (failed) {
      this.error = result.error;
      return false;
    }

    previousOutputs.push(this.stringifyOutput(step.capability, output));
    this.data = output as TOutput;

    return true;
  }

  /**
   * Resolve the steering directive for a just-settled step, shared by the
   * sequential and DAG executors. Fires the user's `onStep` hook, then
   * normalizes the result against the `replan` budget:
   *
   * - explicit `replan` directive — honored only when `config.replan` is
   *   set and the budget remains; otherwise downgraded to `continue`.
   * - explicit `abort` — honored.
   * - failed step with no overriding directive — auto-`replan` when
   *   `config.replan` is set and the budget remains (feedback = the step
   *   error message), else `abort` (today's abort-on-first-failure).
   *
   * Returns `undefined` when the run should simply continue. A returned
   * `replan` directive has ALREADY consumed one unit of the replan budget.
   */
  private async resolveDirective(
    snapshot: PlannerStepSnapshot,
    plan: PlannerPlan,
    completed: boolean,
  ): Promise<PlannerStepDirective | undefined> {
    const hook = this.args.options?.onStep;
    const userDirective = hook ? await hook(snapshot, plan) : undefined;

    if (userDirective?.type === "replan") {
      if (this.canReplan()) {
        this.replanCount++;
        return userDirective;
      }

      // Replan requested but unavailable (no config or budget spent) — fall
      // through to the failure/continue defaults below.
    } else if (userDirective?.type === "abort") {
      return { type: "abort" };
    } else if (userDirective?.type === "continue") {
      return undefined;
    }

    if (!completed) {
      if (this.canReplan()) {
        this.replanCount++;
        return { type: "replan", feedback: snapshot.error?.message ?? "step failed" };
      }

      return { type: "abort" };
    }

    return undefined;
  }

  /** Whether a re-plan is configured and the budget has room. */
  private canReplan(): boolean {
    const replan = this.args.config.replan;

    return replan !== undefined && this.replanCount < replan.maxReplans;
  }

  /**
   * Re-ask the planning agent for a plan over the REMAINING work — a
   * second `generatePlan()` seeded with the executed-step digest plus the
   * caller's feedback. Reuses the exact `generatePlan` plumbing (same
   * schema, same `PlannerPlanInvalidError` handling), so a regenerated
   * plan that is empty or names an unknown capability fails identically.
   * The failed step's error is cleared so the regenerated plan runs
   * cleanly; a fresh failure (or exhausted budget) re-sets it.
   */
  private async regeneratePlan(feedback: string): Promise<PlannerPlan | undefined> {
    this.error = undefined;
    return this.generatePlan(feedback);
  }

  /**
   * The executed-so-far digest — one context line per completed step, in
   * execution order. Seeds the regenerated plan's first step so it builds
   * on what already ran.
   */
  private executedDigest(): string[] {
    return this.executedSteps
      .filter((snapshot) => snapshot.status === "completed")
      .map((snapshot) => this.stringifyOutput(snapshot.step.capability, snapshot.output));
  }

  /** The last-pushed snapshot for a given step index, if any. */
  private snapshotFor(index: number): PlannerStepSnapshot | undefined {
    for (let position = this.executedSteps.length - 1; position >= 0; position--) {
      const snapshot = this.executedSteps[position] as PlannerStepSnapshot;

      if (snapshot.index === index) {
        return snapshot;
      }
    }

    return undefined;
  }

  /** Record every step from `from` onward (in a flat array plan) as skipped. */
  private skipRest(steps: PlannerStep[], from: number): void {
    for (let rest = from; rest < steps.length; rest++) {
      this.recordSkipped(rest, steps[rest] as PlannerStep);
    }
  }

  /** Record every not-yet-`done` DAG node as skipped, in plan order. */
  private skipDagRest(dag: PlannerDag, done: ReadonlySet<string>): void {
    for (const node of dag.nodes) {
      if (!done.has(node.id)) {
        this.recordSkipped(node.index, node.step);
      }
    }
  }

  /**
   * Set `this.data` from the DAG's topological sink for a configured
   * `output` schema. "Last completed step" is meaningless under
   * parallelism, so the sink (the step nothing depends on) is the
   * unambiguous final output. Multiple sinks while an `output` schema is
   * set is a convergence error — a typed `PlannerPlanInvalidError`.
   */
  private finalizeDagOutput(
    dag: PlannerDag,
    completed: ReadonlySet<string>,
    rawOutputs: Map<string, unknown>,
  ): void {
    const schema = this.args.options?.output ?? this.args.config.output;

    if (!schema || this.error) {
      return;
    }

    const sinks = sinkNodes(dag).filter((node) => completed.has(node.id));

    if (sinks.length > 1) {
      this.error = new PlannerPlanInvalidError(
        `ai.planner("${this.args.config.name}"): DAG has multiple sinks but an \`output\` schema is set — the plan must converge to a single final step`,
        { context: { runId: this.runId, sinks: sinks.map((node) => node.id) } },
      );
      this.data = undefined;
      return;
    }

    const sink = sinks[0] as DagNode | undefined;
    this.data = (sink ? rawOutputs.get(sink.id) : undefined) as TOutput | undefined;
  }

  /**
   * Phase 3 — when an `output` schema is configured (factory or per-call
   * override), validate the final completed step's output into typed
   * `result.data`. A validation failure replaces the run error and flips
   * the status to failed.
   */
  private async finalizeOutput(): Promise<void> {
    const schema = this.args.options?.output ?? this.args.config.output;

    if (!schema || this.error) {
      return;
    }

    if (this.data === undefined) {
      // An `output` schema is configured but the final completed step
      // produced nothing to validate — returning `{ data: undefined,
      // error: undefined, status: "completed" }` would be a silent
      // contract violation. Surface it as an invalid plan instead.
      this.error = new PlannerPlanInvalidError(
        `ai.planner("${this.args.config.name}"): plan completed without producing output for the configured \`output\` schema`,
        { context: { runId: this.runId } },
      );
      return;
    }

    const validation = await schema["~standard"].validate(this.data);

    if (validation.issues) {
      this.error = new PlannerPlanInvalidError(
        `ai.planner("${this.args.config.name}"): final output failed validation`,
        {
          context: {
            runId: this.runId,
            issues: validation.issues.map((issue) => issue.message),
          },
        },
      );
      this.data = undefined;
      return;
    }

    this.data = validation.value as TOutput;
  }

  /**
   * Phase 4 — fold the accumulators into the planner's own
   * {@link PlannerReport} node and the final {@link PlannerResult}, then
   * stamp lineage across the whole subtree so every child shares this
   * run's root id.
   */
  private buildResult(): PlannerResult<TOutput> {
    const status = this.resolveStatus();

    const report: PlannerReport = {
      runId: this.runId,
      rootRunId: this.runId,
      name: this.args.config.name,
      version: this.args.config.version,
      type: "planner",
      status,
      // Stamp the terminal error so the observe path surfaces it on the
      // planner span (no result envelope reaches an observer). Absent on
      // a completed run.
      ...(this.error ? { error: this.error } : {}),
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      duration: performance.now() - this.startPerf,
      usage: this.usage,
      children: this.children,
      signature: this.args.signature,
      plan: this.plan,
      executedSteps: this.executedSteps,
      cancelledAt: this.cancelledAt,
      reportSchemaVersion: REPORT_SCHEMA_VERSION,
    };

    stampReportLineage(report, {
      rootRunId: this.runId,
      sessionId: this.args.options?.sessionId,
    });

    const result: PlannerResult<TOutput> = {
      type: "planner",
      data: this.error ? undefined : this.data,
      error: this.error,
      usage: this.usage,
      report,
    };

    // Plan-only mode surfaces the validated plan WITHOUT execution so the
    // caller can sign off and re-run with `approvedPlan`.
    if (this.awaitingApproval) {
      result.plan = this.plan;
    }

    return result;
  }

  /**
   * Resolve the terminal status from the accumulated outcome.
   * `awaiting-approval` (plan-only short-circuit) wins over everything —
   * nothing executed, so neither cancellation nor error applies.
   * Otherwise cancelled wins over failed (an abort that also produced a
   * step error still reads as cancelled); failed wins over completed.
   */
  private resolveStatus(): PlannerReport["status"] {
    if (this.awaitingApproval) {
      return "awaiting-approval";
    }

    if (this.cancelledAt !== undefined) {
      return "cancelled";
    }

    if (this.error) {
      return "failed";
    }

    return "completed";
  }

  /**
   * Build the prompt handed to the planning agent. On the first pass this
   * is just the user's goal (byte-for-byte unchanged). On a RE-plan it
   * prepends the executed-step digest and the steering feedback so the
   * planner revises the remaining work.
   */
  private buildPlanPrompt(feedback?: string): string {
    if (feedback === undefined) {
      return this.args.goal;
    }

    const digest = this.executedDigest();
    const sections: string[] = [`Goal: ${this.args.goal}`, ""];

    if (digest.length > 0) {
      sections.push("Steps already completed:", ...digest, "");
    }

    sections.push(
      `Feedback requiring a revised plan: ${feedback}`,
      "",
      "Produce a plan for the REMAINING work only.",
    );

    return sections.join("\n");
  }

  /**
   * Compose a step's effective input: the step's own `input`, prefixed
   * with a compact digest of every prior step's output so a downstream
   * capability can build on what ran before it. No prior output → the
   * step's raw input.
   */
  private composeStepInput(step: PlannerStep, previousOutputs: string[]): string {
    if (previousOutputs.length === 0) {
      return step.input;
    }

    return [
      "Context from earlier steps:",
      ...previousOutputs,
      "",
      `Task: ${step.input}`,
    ].join("\n");
  }

  /**
   * Pull the usable output off a capability's result. Prefers structured
   * `data` (agents/workflows with an `output` schema, tools), and falls
   * back to an agent's raw `text` when no structured data was produced —
   * the common case for a plain text-producing capability agent.
   */
  private extractOutput(result: BaseResult): unknown {
    const shaped = result as { data?: unknown; text?: unknown };

    if (shaped.data !== undefined) {
      return shaped.data;
    }

    if (typeof shaped.text === "string") {
      return shaped.text;
    }

    return undefined;
  }

  /** Serialize a capability output into a single context line for the next step. */
  private stringifyOutput(capability: string, output: unknown): string {
    if (output === undefined) {
      return `- ${capability}: (no output)`;
    }

    if (typeof output === "string") {
      return `- ${capability}: ${output}`;
    }

    return `- ${capability}: ${JSON.stringify(output)}`;
  }

  /** Push a `skipped` snapshot for a step the planner never dispatched. */
  private recordSkipped(index: number, step: PlannerStep): void {
    const now = new Date().toISOString();

    this.executedSteps.push({
      index,
      step,
      status: "skipped",
      startedAt: now,
      endedAt: now,
      duration: 0,
      usage: { input: 0, output: 0, total: 0 },
    });
  }

  /** Fold a child's usage + report node into the planner's accumulators. */
  private absorb(usage: Usage, report: BaseReport | undefined): void {
    this.mergeUsage(this.usage, usage);

    if (report) {
      this.children.push(report);
    }
  }

  /**
   * Add a child's usage into the running total. Mirrors the batch
   * primitive's rollup: scalar token channels sum directly, optional
   * sub-channels accumulate only when reported, and the cost breakdown
   * merges via {@link accumulateCost} so one unpriced child can't erase
   * priced siblings.
   */
  private mergeUsage(target: Usage, child: Usage): void {
    target.input += child.input;
    target.output += child.output;
    target.total += child.total;

    if (child.cachedTokens !== undefined) {
      target.cachedTokens = (target.cachedTokens ?? 0) + child.cachedTokens;
    }

    if (child.reasoningTokens !== undefined) {
      target.reasoningTokens = (target.reasoningTokens ?? 0) + child.reasoningTokens;
    }

    if (child.cacheWriteTokens !== undefined) {
      target.cacheWriteTokens = (target.cacheWriteTokens ?? 0) + child.cacheWriteTokens;
    }

    const mergedCost = accumulateCost(target.cost, child.cost);

    if (mergedCost !== undefined) {
      target.cost = mergedCost;
    }
  }

  /**
   * Re-derive the sequential cursor + prior-output context from the
   * persisted ledger on resume. Threads every already-`completed` node's
   * output into `previousOutputs`, returns the first index NOT completed
   * as the resume cursor, and prunes stale non-completed ledger entries
   * (the failed node + any skipped tail) at-or-after that cursor so the
   * re-run repopulates them without duplicating.
   */
  private rehydrateSequentialState(
    steps: PlannerStep[],
    previousOutputs: string[],
  ): number {
    let cursor = 0;

    for (let index = 0; index < steps.length; index++) {
      const snapshot = this.snapshotFor(index);

      if (snapshot?.status === "completed") {
        const step = steps[index] as PlannerStep;
        previousOutputs.push(this.stringifyOutput(step.capability, snapshot.output));
        cursor = index + 1;
        continue;
      }

      // First non-completed index — this is where the re-run resumes.
      break;
    }

    // Drop any ledger entries at-or-after the cursor (failed / skipped
    // from the crashed run) so the resumed loop's pushes don't duplicate.
    this.pruneLedgerFrom(cursor);

    return cursor;
  }

  /**
   * Re-derive the DAG scheduler's working sets from the persisted ledger
   * on resume. Completed nodes go into `completed` + `done` with their
   * string + raw outputs restored (so dependents read the right context);
   * stale non-completed entries are pruned so the re-run repopulates them.
   * Returns the count of nodes already dispatched (for the `maxSteps`
   * truncation budget).
   */
  private rehydrateDagState(
    dag: PlannerDag,
    completed: Set<string>,
    done: Set<string>,
    outputs: Map<string, string>,
    rawOutputs: Map<string, unknown>,
  ): number {
    const completedIndices = new Set<number>();

    for (const node of dag.nodes) {
      const snapshot = this.snapshotFor(node.index);

      if (snapshot?.status !== "completed") {
        continue;
      }

      completed.add(node.id);
      done.add(node.id);
      completedIndices.add(node.index);
      rawOutputs.set(node.id, snapshot.output);
      outputs.set(node.id, this.stringifyOutput(node.step.capability, snapshot.output));
    }

    // Prune every non-completed ledger entry so the re-run's pushes don't
    // duplicate the failed / skipped frontier from the crashed run.
    const retained = this.executedSteps.filter((snapshot) =>
      completedIndices.has(snapshot.index),
    );
    this.executedSteps.length = 0;
    this.executedSteps.push(...retained);

    return completedIndices.size;
  }

  /**
   * Drop every ledger entry whose index is at or after `from`. Used by
   * the sequential resume re-seed to clear the crashed run's failed /
   * skipped frontier before the re-run repopulates it.
   */
  private pruneLedgerFrom(from: number): void {
    const retained = this.executedSteps.filter((snapshot) => snapshot.index < from);
    this.executedSteps.length = 0;
    this.executedSteps.push(...retained);
  }

  /**
   * Map the run's terminal outcome to the persisted snapshot status.
   * `awaiting-approval` (plan-only) never persists a durable snapshot
   * (resume is always an execution), so it folds to `running` here —
   * but the durable + plan-only combination is disallowed at the call
   * site, so this path is effectively unreachable.
   */
  private resolveSnapshotStatus(): PlannerSnapshotStatus {
    if (this.cancelledAt !== undefined) {
      return "cancelled";
    }

    if (this.error) {
      return "failed";
    }

    if (this.awaitingApproval) {
      return "running";
    }

    return "completed";
  }

  /**
   * Build and persist a {@link PlannerSnapshot} from the current
   * accumulators. The per-node and terminal checkpoints both route
   * through here. No-op when `durable` is absent. A failed persist is
   * logged and swallowed (never aborts the run), matching the supervisor
   * / workflow checkpoint policy.
   */
  private async checkpoint(status: PlannerSnapshotStatus): Promise<void> {
    if (!this.args.config.durable || !this.plan) {
      return;
    }

    const outcome = await persistPlannerSnapshot({
      durable: this.args.config.durable,
      runId: this.runId,
      plannerName: this.args.config.name,
      signature: this.args.signature,
      version: this.args.config.version,
      goal: this.args.goal,
      plan: this.plan,
      executedSteps: this.executedSteps,
      usage: this.usage,
      children: this.children,
      replanCount: this.replanCount,
      status,
      startedAt: this.startedAt,
    });

    if (!outcome.ok) {
      this.logDurableFailure("snapshot.persist.failed", outcome.error);
    }
  }

  /**
   * Re-derive the terminal state when a resume short-circuits a snapshot
   * whose run already COMPLETED. The persisted ledger is the
   * authoritative outcome — `this.data` is restored from the last
   * completed node so the rebuilt result carries the final output.
   *
   * Only reached for a `completed` snapshot — `failed` / `cancelled`
   * snapshots re-enter execution to retry the unfinished frontier instead.
   */
  private rebuildResumedTerminal(_status: PlannerSnapshotStatus): void {
    const lastCompleted = [...this.executedSteps]
      .reverse()
      .find((snapshot) => snapshot.status === "completed");

    if (lastCompleted) {
      this.data = lastCompleted.output as TOutput;
    }
  }

  /** Structured-log a durable persist/delete failure. */
  private logDurableFailure(action: string, error: unknown): void {
    log.warn("ai.planner", action, "durable snapshot operation failed", {
      runId: this.runId,
      planner: this.args.config.name,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  /** Whether the caller's abort signal has fired. */
  private isAborted(): boolean {
    return this.args.options?.signal?.aborted === true;
  }

  /** Record a cancellation observation, setting the run error once. */
  private markCancelled(): void {
    if (this.cancelledAt !== undefined) {
      return;
    }

    this.cancelledAt = new Date().toISOString();

    const reason = this.args.options?.signal?.reason;

    this.error = new PlannerCancelledError(
      `ai.planner("${this.args.config.name}"): run cancelled`,
      {
        cancelledAt: this.cancelledAt,
        reason: typeof reason === "string" ? reason : undefined,
        context: { runId: this.runId },
      },
    );
  }

  /** Normalize any thrown value into a typed {@link AIError}. */
  private toAIError(caught: unknown): AIError {
    if (caught instanceof AIError) {
      return caught;
    }

    const message = caught instanceof Error ? caught.message : String(caught);

    return new PlannerFailedError(`ai.planner("${this.args.config.name}"): ${message}`, {
      cause: caught,
      context: { runId: this.runId },
    });
  }
}
