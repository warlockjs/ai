import { log } from "@warlock.js/logger";
import type { BaseReport } from "../contracts/result/base-report.type";
import type { StepSnapshot } from "../contracts/result/step-result.type";
import type { Usage } from "../contracts/result/usage.type";
import type {
  WorkflowReport,
  WorkflowResult,
} from "../contracts/result/workflow-result.type";
import type { StepDefinition } from "../contracts/workflow/step.contract";
import type { WorkflowContext } from "../contracts/workflow/workflow-context.type";
import type { WorkflowSnapshot } from "../contracts/workflow/workflow-snapshot.type";
import type {
  WorkflowDefinition,
  WorkflowEventHandlers,
} from "../contracts/workflow/workflow.contract";
import {
  AIError,
  MaxStepsExceededError,
  RoutingError,
  SchemaValidationError,
  WorkflowCancelledError,
  WorkflowError,
} from "../errors";
import { stampReportLineage } from "../utils";
import { createCancelledError } from "./cancellation";
import type { WorkflowEmitter } from "./emitter";
import { mapNextStep, nextDeclaredStep, resolveNextStep } from "./router";
import { runScopedEmitter } from "./run-scoped-emitter";
import { persistSnapshot } from "./snapshot";
import { cloneState, deepFreeze } from "./state";
import { executeStep, finalizeSnapshot, toAIError } from "./step-runner";

export { loadSnapshotForResume } from "./snapshot";

const DEFAULT_MAX_STEPS = 100;
const DEFAULT_LOOP_WARN = 5;
const LOG_MODULE_BASE = "ai.workflow";

type EngineParams<TOutput> = {
  definition: WorkflowDefinition<any, TOutput, any, any>;
  signature: string;
  emitter: WorkflowEmitter;
  input: unknown;
  /**
   * Request-scoped envelope, frozen and exposed as `ctx.context` to
   * every step. Never persisted in snapshots; resume callers supply
   * it fresh via `WorkflowResumeOptions.context`. Defaults to a
   * frozen empty object when caller omits it.
   */
  context?: unknown;
  runId: string;
  signal?: AbortSignal;
  executionHandlers?: WorkflowEventHandlers;
  resumeFrom?: WorkflowSnapshot;
  /**
   * Opaque session identifier propagated onto every report node this
   * run produces — including agent reports from child steps. Threaded
   * from `WorkflowRunOptions.sessionId`. Omitted leaves the field
   * undefined throughout the tree.
   */
  sessionId?: string;
};

/**
 * Main workflow driver. Walks the declared steps, handling routing,
 * cancellation, retries, parallel execution, and snapshot
 * persistence. Delegates the step lifecycle to `step-runner.ts`,
 * routing to `router.ts`, persistence to `snapshot.ts`. Never throws
 * — every failure funnels into `result.error`.
 */
export async function runWorkflow<TOutput>(
  params: EngineParams<TOutput>,
): Promise<WorkflowResult<TOutput>> {
  const { definition, signature, input, runId, signal } = params;
  // Bind the factory-scoped emitter to THIS run's identity. Every
  // `emitter.emit(...)` below — and the one threaded into
  // `executeStep` — now stamps `runId` / `rootRunId` automatically.
  const emitter = runScopedEmitter(params.emitter, {
    runId,
    rootRunId: runId,
  });

  // Freeze the envelope once at run start. Default to `{}` so step
  // code can always read `ctx.context` without an undefined guard.
  const context = Object.freeze(params.context ?? {});
  const maxSteps = definition.maxSteps ?? DEFAULT_MAX_STEPS;
  const loopWarnAfter = definition.loopWarnAfter ?? DEFAULT_LOOP_WARN;

  const logger = log;
  const logModule = `${LOG_MODULE_BASE}.${definition.name}`;

  const stepByName = new Map<string, StepDefinition>();
  for (const s of definition.steps) stepByName.set(s.name, s);

  const state: Record<string, unknown> = params.resumeFrom
    ? { ...params.resumeFrom.state }
    : {};
  const steps: Record<string, StepSnapshot> = params.resumeFrom
    ? { ...params.resumeFrom.steps }
    : {};
  const enteredCount = new Map<string, number>();
  const usage: Usage = { input: 0, output: 0, total: 0 };

  const startedAt = params.resumeFrom?.startedAt ?? new Date().toISOString();
  const startedAtDate = new Date(startedAt);
  const runStartPerf = performance.now();

  let error: AIError | undefined;
  let status: "completed" | "failed" | "cancelled" = "completed";
  let cancelledAt: string | undefined;
  let lastGoto: string | null = null;
  // Captured when a step throws after retries exhaust (and `onFailure`
  // didn't recover). Used to point the final snapshot's `next` at the
  // failed step so `resume()` re-runs it after the cause is fixed.
  let failedStepName: string | undefined;

  const buildContext = (current?: {
    state: Record<string, unknown>;
    agentResult?: unknown;
  }): WorkflowContext => ({
    input,
    context,
    steps: steps as Readonly<Record<string, StepSnapshot>>,
    state: current?.state ?? state,
    agentResult: current?.agentResult as WorkflowContext["agentResult"],
    runId,
    signal,
    startedAt: startedAtDate,
  });

  emitter.emit(
    "workflow.starting",
    { workflowName: definition.name, input },
    params.executionHandlers,
  );
  logger.info(logModule, "starting", "workflow starting", { runId });

  let currentName: string | null = resolveInitialStep(
    definition,
    params.resumeFrom,
  );
  let stepCount = 0;

  try {
    while (currentName !== null) {
      if (signal?.aborted) throw createCancelledError(signal);

      stepCount += 1;
      if (stepCount > maxSteps) {
        throw new MaxStepsExceededError(
          `workflow "${definition.name}" exceeded maxSteps=${maxSteps}`,
          { maxSteps },
        );
      }

      const entered = (enteredCount.get(currentName) ?? 0) + 1;
      enteredCount.set(currentName, entered);
      if (entered === loopWarnAfter) {
        emitter.emit(
          "workflow.loop.warning",
          { step: currentName, enteredCount: entered, lastGoto },
          params.executionHandlers,
        );
        logger.warn(logModule, "loop.warning", "loop warning", {
          step: currentName,
          enteredCount: entered,
        });
      }

      const step = stepByName.get(currentName);
      if (!step) {
        throw new RoutingError(
          `workflow "${definition.name}": unknown step "${currentName}"`,
          { stepName: currentName },
        );
      }

      const snapshot = await executeStep({
        step,
        state,
        emitter,
        executionHandlers: params.executionHandlers,
        logger,
        logModule,
        signal,
        buildContext,
        usage,
        workflowDefaultRetry: definition.defaultRetry,
      });

      Object.assign(state, snapshot.state);
      steps[step.name] = finalizeSnapshot(snapshot);
      // Parallel children — flat-path addressing alongside nested.
      if (snapshot.steps) {
        for (const [childName, childSnap] of Object.entries(snapshot.steps)) {
          steps[childName] = childSnap;
        }
      }

      // Failure path: retries exhausted. Give `onFailure` a chance to
      // recover; otherwise checkpoint at the failed step (so resume
      // re-runs it) and throw — workflow halts.
      if (snapshot.status === "failed" && snapshot.error) {
        const failureRoute = await resolveFailureRoute({
          step,
          definition,
          error: snapshot.error,
          ctx: buildContext({ state, agentResult: snapshot.executionResult }),
        });

        if (failureRoute === undefined) {
          // No recovery — persist with `next: step.name` so resume
          // re-runs this step after the user fixes the cause.
          const persistOutcome = await persistSnapshot({
            definition,
            signature,
            runId,
            startedAt,
            input,
            state,
            steps,
            next: step.name,
            status: "running",
          });
          if (!persistOutcome.ok) {
            const persistErr = toAIError(persistOutcome.error);
            emitter.emit(
              "workflow.error",
              { error: persistErr },
              params.executionHandlers,
            );
            logger.error(
              logModule,
              "persist.failed",
              "snapshot persist failed",
              {
                step: step.name,
                code: persistErr.code,
                message: persistErr.message,
              },
            );
          }
          failedStepName = step.name;
          throw snapshot.error;
        }

        // onFailure routed — workflow continues. Checkpoint at the
        // routed target (or `null` for `end`) so resume picks up there.
        const failureNext = failureRoute === "end" ? null : failureRoute;
        if (failureNext !== null && !stepByName.has(failureNext)) {
          throw new RoutingError(
            `workflow "${definition.name}": step "${step.name}" onFailure routed to unknown target "${failureNext}"`,
            { stepName: step.name, targetName: failureNext },
          );
        }

        const failurePersist = await persistSnapshot({
          definition,
          signature,
          runId,
          startedAt,
          input,
          state,
          steps,
          next: failureNext,
          status: "running",
        });
        if (!failurePersist.ok) {
          const persistErr = toAIError(failurePersist.error);
          emitter.emit(
            "workflow.error",
            { error: persistErr },
            params.executionHandlers,
          );
          logger.error(
            logModule,
            "persist.failed",
            "snapshot persist failed",
            {
              step: step.name,
              code: persistErr.code,
              message: persistErr.message,
            },
          );
        }

        if (signal?.aborted) throw createCancelledError(signal);

        if (failureRoute === "end") {
          currentName = null;
          break;
        }

        lastGoto = failureRoute;
        currentName = failureRoute;
        continue;
      }

      // Resolve next step for checkpoint accuracy BEFORE routing errors
      // bubble — so the snapshot records where resume should resume from.
      const resolved = await resolveNextStep({
        step,
        definition,
        ctx: buildContext({ state, agentResult: snapshot.executionResult }),
      });

      const nextName =
        resolved === "end"
          ? null
          : typeof resolved === "string"
            ? resolved
            : nextDeclaredStep(definition, step.name);

      // Checkpoint after every step with the resolved `next`.
      const outcome = await persistSnapshot({
        definition,
        signature,
        runId,
        startedAt,
        input,
        state,
        steps,
        next: nextName,
        status: "running",
      });
      if (!outcome.ok) {
        const persistErr = toAIError(outcome.error);
        emitter.emit(
          "workflow.error",
          { error: persistErr },
          params.executionHandlers,
        );
        logger.error(logModule, "persist.failed", "snapshot persist failed", {
          step: step.name,
          code: persistErr.code,
          message: persistErr.message,
        });
      }

      if (signal?.aborted) throw createCancelledError(signal);

      if (resolved === "end") {
        currentName = null;
        break;
      }

      if (typeof resolved === "string") {
        if (!stepByName.has(resolved)) {
          throw new RoutingError(
            `workflow "${definition.name}": step "${step.name}" goto unknown target "${resolved}"`,
            { stepName: step.name, targetName: resolved },
          );
        }
        lastGoto = resolved;
        currentName = resolved;
        continue;
      }

      currentName = nextName;
      lastGoto = currentName;
    }
  } catch (err) {
    if (err instanceof WorkflowCancelledError) {
      status = "cancelled";
      cancelledAt = err.cancelledAt;
      error = err;
    } else if (err instanceof AIError) {
      status = "failed";
      error = err;
    } else {
      status = "failed";
      error = new WorkflowError(
        err instanceof Error ? err.message : String(err),
        { cause: err },
      );
    }
  }

  // Note: a `failed` step always throws (caught above) unless its
  // `onFailure` recovered the run. A `completed` workflow may still
  // contain `failed` step snapshots — those are the recovered cases
  // and are intentionally preserved for forensic trace.

  const endedAt = new Date().toISOString();
  const duration = performance.now() - runStartPerf;

  let data: TOutput | undefined;
  if (status === "completed" && definition.output) {
    try {
      const extracted = await definition.output.extract(
        buildContext({ state }),
      );
      data = (await validateWorkflowOutput(
        definition.output.schema,
        extracted,
      )) as TOutput;
    } catch (err) {
      status = "failed";
      error =
        err instanceof AIError
          ? err
          : new WorkflowError(
              err instanceof Error ? err.message : String(err),
              { cause: err },
            );
    }
  }

  // Collect child executable reports from every step that ran one.
  // Today the step runner surfaces agent reports (the only executable
  // kind steps can invoke natively via `step.agent`); custom `run`
  // callbacks that call tools/workflows/supervisors can't be observed
  // here without a richer step-runner API — that's a v1.x follow-up
  // (see backlog: "step.run executables surface in workflow tree").
  const children: BaseReport[] = [];
  for (const stepName in steps) {
    const snap = steps[stepName];
    if (snap.agentReport) {
      children.push(snap.agentReport);
    }
  }

  const report: WorkflowReport = {
    runId,
    rootRunId: runId,
    name: definition.name,
    version: definition.version,
    type: "workflow",
    workflowName: definition.name,
    signature,
    status,
    // Stamp the terminal error onto the report so it travels with the tree
    // (observe path has no result envelope to fall back on). A failed `run`
    // step's cause lives in `steps[name].error`, but the workflow-level
    // error is what a consumer reads off the root span. Absent on success.
    ...(error ? { error } : {}),
    startedAt,
    endedAt,
    duration,
    cancelledAt,
    usage,
    children,
    steps,
    state: deepFreeze(cloneState(state)),
  };

  // Stamp lineage on the assembled tree exactly once. Walker rewrites
  // any inner self-roots that nested agent reports brought in (each
  // agent's `buildResult` set its own runId as root), propagates
  // sessionId, and writes `reportSchemaVersion` on the root.
  stampReportLineage(report, {
    rootRunId: runId,
    sessionId: params.sessionId,
  });

  // On a failed run with a captured `failedStepName`, point `next` at
  // the failed step so `resume()` re-runs it. The pre-throw checkpoint
  // already wrote this value, but the final snapshot would otherwise
  // overwrite it with `null` and force resume to fall back to the
  // first non-completed step (which is the same step in practice, but
  // less informative for tooling reading the snapshot).
  const finalNext = status === "failed" ? failedStepName ?? null : null;

  const finalOutcome = await persistSnapshot({
    definition,
    signature,
    runId,
    startedAt,
    input,
    state,
    steps,
    next: finalNext,
    status,
  });
  if (!finalOutcome.ok) {
    const persistErr = toAIError(finalOutcome.error);
    emitter.emit(
      "workflow.error",
      { error: persistErr },
      params.executionHandlers,
    );
    logger.error(logModule, "persist.failed", "final snapshot persist failed", {
      code: persistErr.code,
      message: persistErr.message,
    });
  }

  const result: WorkflowResult<TOutput> = {
    type: "workflow",
    data,
    report,
    usage,
    error,
  };

  if (status === "cancelled") {
    emitter.emit(
      "workflow.cancelled",
      {
        cancelledAt: cancelledAt ?? endedAt,
        reason: (error as WorkflowCancelledError | undefined)?.reason ?? "",
      },
      params.executionHandlers,
    );
    logger.warn(logModule, "cancelled", "workflow cancelled", { runId });
  }

  if (status === "failed" && error) {
    emitter.emit("workflow.error", { error }, params.executionHandlers);
    logger.error(logModule, "error", "workflow failed", {
      runId,
      code: error.code,
      message: error.message,
    });
  }

  emitter.emit(
    "workflow.completed",
    { result: result as WorkflowResult<unknown> },
    params.executionHandlers,
  );
  logger.info(logModule, "completed", "workflow completed", {
    runId,
    status,
    duration,
  });

  return result;
}

/**
 * Run a failed step's `onFailure` hook (if present) and translate its
 * result into a route. Returns `undefined` when the workflow should
 * halt with the original error; `"end"` for clean termination; or a
 * step name to redirect to. A throw inside `onFailure` is wrapped in
 * `RoutingError` — routing is authoritative, never retried.
 */
async function resolveFailureRoute<T>(params: {
  step: StepDefinition;
  definition: WorkflowDefinition<any, T, any, any>;
  error: AIError;
  ctx: WorkflowContext;
}): Promise<"end" | string | undefined> {
  const { step, definition, error, ctx } = params;
  if (!step.onFailure) return undefined;

  let outcome;
  try {
    outcome = await step.onFailure(ctx, error);
  } catch (err) {
    throw new RoutingError(
      `workflow "${definition.name}": step "${step.name}" onFailure threw`,
      { stepName: step.name, cause: err },
    );
  }
  return mapNextStep(outcome);
}

function resolveInitialStep<T>(
  definition: WorkflowDefinition<any, T, any, any>,
  resumeFrom: WorkflowSnapshot | undefined,
): string | null {
  if (!resumeFrom) return definition.steps[0]?.name ?? null;

  // Prefer the explicitly-recorded `next` (now populated on every
  // checkpoint). Falls back to first step whose snapshot is missing
  // or not in a terminal-success state — covers older snapshots
  // written before `next` was wired.
  if (
    resumeFrom.next &&
    definition.steps.some(s => s.name === resumeFrom.next)
  ) {
    return resumeFrom.next;
  }

  for (const step of definition.steps) {
    const snap = resumeFrom.steps[step.name];
    if (!snap || (snap.status !== "completed" && snap.status !== "skipped")) {
      return step.name;
    }
  }

  return null;
}

async function validateWorkflowOutput(
  schema: unknown,
  value: unknown,
): Promise<unknown> {
  if (!schema) return value;

  const result = await (
    schema as {
      "~standard": { validate: (v: unknown) => Promise<unknown> | unknown };
    }
  )["~standard"].validate(value);

  if (
    result &&
    typeof result === "object" &&
    "issues" in result &&
    (result as { issues: unknown }).issues
  ) {
    throw new SchemaValidationError(
      "workflow output failed schema validation",
      {
        issues: (result as { issues: any }).issues,
      },
    );
  }

  return (result as { value: unknown }).value;
}
