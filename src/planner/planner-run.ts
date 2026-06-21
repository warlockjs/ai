import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { AgentContract } from "../contracts/agent/agent.contract";
import type { PlannerCapability } from "../contracts/planner/planner-capability.type";
import type { PlannerConfig } from "../contracts/planner/planner-config.type";
import type { PlannerExecuteOptions } from "../contracts/planner/planner-execute-options.type";
import type { PlannerPlan, PlannerStep } from "../contracts/planner/planner-plan.type";
import type {
  PlannerReport,
  PlannerResult,
  PlannerStepSnapshot,
} from "../contracts/planner/planner-result.type";
import type { BaseReport } from "../contracts/result/base-report.type";
import { REPORT_SCHEMA_VERSION } from "../contracts/result/base-report.type";
import type { BaseResult } from "../contracts/result/base-result.type";
import type { Usage } from "../contracts/result/usage.type";
import { AIError } from "../errors/ai-error";
import { PlannerCancelledError } from "../errors/planner-cancelled-error";
import { PlannerFailedError } from "../errors/planner-failed-error";
import { PlannerPlanInvalidError } from "../errors/planner-plan-invalid-error";
import { SchemaValidationError } from "../errors/schema-validation-error";
import { accumulateCost } from "../utils/compute-cost";
import { generateRunId } from "../utils/generate-run-id";
import { stampReportLineage } from "../utils/stamp-report-lineage";
import { planSchema } from "./plan-schema";

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
  private readonly startedAt = new Date().toISOString();
  private readonly startPerf = performance.now();

  private readonly usage: Usage = { input: 0, output: 0, total: 0 };
  private readonly children: BaseReport[] = [];
  private readonly executedSteps: PlannerStepSnapshot[] = [];

  private plan?: PlannerPlan;
  private data?: TOutput;
  private error?: AIError;
  private cancelledAt?: string;

  public constructor(private readonly args: PlannerRunArgs<TOutput>) {
    this.runId = args.options?.runId ?? generateRunId("planner");
  }

  /**
   * Run the planner end-to-end. Never throws on runtime failure —
   * generation errors, plan-validity errors, step failures, and
   * cancellation all surface on `result.error` with a narrowing
   * `report.status`.
   */
  public async run(): Promise<PlannerResult<TOutput>> {
    try {
      if (this.isAborted()) {
        this.markCancelled();
        return this.buildResult();
      }

      const plan = await this.generatePlan();

      if (this.error || !plan) {
        return this.buildResult();
      }

      this.plan = plan;

      await this.executePlan(plan);

      await this.finalizeOutput();
    } catch (caught) {
      this.error = this.toAIError(caught);
    }

    return this.buildResult();
  }

  /**
   * Phase 1 — ask the planning agent for a structured plan. The plan
   * schema (built from the live capability names) is supplied as the
   * agent's per-call `output`, so the model is steered to reference only
   * real capabilities. The planning trip's usage + report roll into the
   * planner's totals regardless of outcome.
   */
  private async generatePlan(): Promise<PlannerPlan | undefined> {
    const schema = planSchema([...this.args.capabilities.keys()], this.args.maxSteps);

    const result = await this.args.planningAgent.execute(this.buildPlanPrompt(), {
      output: schema as StandardSchemaV1<unknown>,
      placeholders: this.args.options?.placeholders,
      signal: this.args.options?.signal,
      sessionId: this.args.options?.sessionId,
    });

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

    const unknownStep = plan.steps.find((step) => !this.args.capabilities.has(step.capability));

    if (unknownStep) {
      this.error = new PlannerPlanInvalidError(
        `ai.planner("${this.args.config.name}"): plan references unknown capability "${unknownStep.capability}"`,
        { context: { runId: this.runId, capability: unknownStep.capability } },
      );
      return undefined;
    }

    return plan;
  }

  /**
   * Phase 2 — execute the plan's steps strictly in order, threading each
   * completed step's output into the next step's input context. Stops at
   * the first step failure (its `error` becomes the run error) or when
   * the abort signal fires between steps. Steps beyond `maxSteps` are
   * recorded as `skipped` without running.
   */
  private async executePlan(plan: PlannerPlan): Promise<void> {
    const previousOutputs: string[] = [];

    for (let index = 0; index < plan.steps.length; index++) {
      const step = plan.steps[index] as PlannerStep;

      if (index >= this.args.maxSteps) {
        this.recordSkipped(index, step);
        continue;
      }

      if (this.isAborted()) {
        this.markCancelled();
        this.recordSkipped(index, step);
        continue;
      }

      const completed = await this.executeStep(index, step, previousOutputs);

      if (!completed) {
        // Step failed — record the remaining steps as skipped so the
        // report still describes the whole intended plan, then stop.
        for (let rest = index + 1; rest < plan.steps.length; rest++) {
          this.recordSkipped(rest, plan.steps[rest] as PlannerStep);
        }
        return;
      }
    }
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

    const result = await capability.executable.execute(input, {
      signal: this.args.options?.signal,
      sessionId: this.args.options?.sessionId,
    });

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

    if (failed) {
      this.error = result.error;
      return false;
    }

    previousOutputs.push(this.stringifyOutput(step.capability, output));
    this.data = output as TOutput;

    return true;
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

    return {
      type: "planner",
      data: this.error ? undefined : this.data,
      error: this.error,
      usage: this.usage,
      report,
    };
  }

  /**
   * Resolve the terminal status from the accumulated outcome. Cancelled
   * wins over failed (an abort that also produced a step error still
   * reads as cancelled); failed wins over completed.
   */
  private resolveStatus(): PlannerReport["status"] {
    if (this.cancelledAt !== undefined) {
      return "cancelled";
    }

    if (this.error) {
      return "failed";
    }

    return "completed";
  }

  /** Build the prompt handed to the planning agent — the user's goal. */
  private buildPlanPrompt(): string {
    return this.args.goal;
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
