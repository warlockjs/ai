import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Logger } from "@warlock.js/logger";
import type { AgentResult } from "../contracts/result/agent-result.type";
import type { AgentReport } from "../contracts/result/execution-report.type";
import type { AttemptEntry, StepSnapshot } from "../contracts/result/step-result.type";
import type { Usage } from "../contracts/result/usage.type";
import type { RetryConfig } from "../contracts/workflow/retry-config.type";
import type { StepDefinition } from "../contracts/workflow/step.contract";
import type { WorkflowContext } from "../contracts/workflow/workflow-context.type";
import type { WorkflowEventHandlers } from "../contracts/workflow/workflow.contract";
import { mergeUsage } from "../utils/compute-cost";
import { withoutRunFrame } from "../utils/run-context";
import {
  AIError,
  SchemaValidationError,
  StepFailedError,
  WorkflowCancelledError,
  WorkflowError,
} from "../errors";
import { createCancelledError, sleep } from "./cancellation";
import type { WorkflowEventSink } from "./emitter";
import { isAbortError, resolveBackoff, resolveRetryConfig } from "./retry";
import { cloneState, deepFreeze } from "./state";

/**
 * Mutable snapshot used by the step runner — finalized (deep-frozen)
 * by the engine before being written to `ctx.steps` / `report.steps`.
 */
export type MutableStepSnapshot = {
  output: unknown;
  skipped: boolean;
  status: "completed" | "skipped" | "failed";
  startedAt: string;
  endedAt: string;
  duration: number;
  attempts: number;
  attemptHistory: AttemptEntry[];
  error?: AIError;
  state: Record<string, unknown>;
  executionResult?: unknown;
  agentReport?: AgentReport;
  agentUsage?: Usage;
  steps?: Record<string, StepSnapshot>;
};

/**
 * Narrow an `executionResult` to an `AgentResult` when the step ran
 * an agent. Custom `run` steps return arbitrary values, so the
 * `type: "agent"` discriminant keeps us honest.
 */
function asAgentResult(result: unknown): AgentResult<unknown> | undefined {
  if (!result || typeof result !== "object") return undefined;
  if ((result as { type?: unknown }).type !== "agent") return undefined;
  return result as AgentResult<unknown>;
}

export type ExecuteStepParams = {
  step: StepDefinition;
  state: Record<string, unknown>;
  emitter: WorkflowEventSink;
  executionHandlers?: WorkflowEventHandlers;
  logger: Logger;
  logModule: string;
  signal?: AbortSignal;
  buildContext: (current?: {
    state: Record<string, unknown>;
    agentResult?: unknown;
  }) => WorkflowContext;
  usage: Usage;
  workflowDefaultRetry?: RetryConfig | false;
};

/**
 * Drive one step's full lifecycle — skip evaluation, parallel
 * dispatch, retry loop around before → run|agent → output → after.
 * Returns a mutable snapshot; the engine deep-freezes it before
 * exposing.
 */
export async function executeStep(params: ExecuteStepParams): Promise<MutableStepSnapshot> {
  const { step, emitter, executionHandlers, logger, logModule, signal } = params;
  const startedAt = new Date().toISOString();
  const stepStartPerf = performance.now();

  params.step.on?.starting?.({ step: step.name });
  emitter.emit("workflow.step.starting", { step: step.name }, executionHandlers);
  logger.debug(logModule, "step.starting", `${step.name} step starting`, {
    step: step.name,
  });

  const stepState: Record<string, unknown> = cloneState(params.state);

  // SKIP
  try {
    if (step.skip) {
      const shouldSkip = await step.skip(params.buildContext({ state: stepState }));
      if (shouldSkip) {
        const endedAt = new Date().toISOString();
        const duration = performance.now() - stepStartPerf;
        emitter.emit("workflow.step.skipped", { step: step.name }, executionHandlers);
        logger.debug(logModule, "step.skipped", `${step.name} step skipped`, {
          step: step.name,
        });

        return {
          output: undefined,
          skipped: true,
          status: "skipped",
          startedAt,
          endedAt,
          duration,
          attempts: 0,
          attemptHistory: [],
          state: stepState,
        };
      }
    }
  } catch (err) {
    return buildFailedSnapshot(step, stepState, startedAt, stepStartPerf, 1, [
      failedAttempt(1, err, new Date().toISOString(), performance.now()),
    ]);
  }

  // PARALLEL
  if (step.parallel && step.parallel.length > 0) {
    return runParallelStep({
      ...params,
      step,
      stepState,
      startedAt,
      startPerf: stepStartPerf,
    });
  }

  const retryConfig = resolveRetryConfig(step, params.workflowDefaultRetry);

  const attempts: AttemptEntry[] = [];
  const totalAttempts = Math.max(1, retryConfig.attempts ?? 1);
  let lastError: unknown;
  let executionResult: unknown;
  let output: unknown;
  let succeeded = false;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    if (signal?.aborted) throw createCancelledError(signal);

    const attemptStart = new Date().toISOString();
    const attemptStartPerf = performance.now();
    try {
      // Fresh deep-clone per attempt — retries restart cleanly.
      const attemptState: Record<string, unknown> = cloneState(params.state);

      if (step.before) {
        await step.before(params.buildContext({ state: attemptState }));
      }

      if (step.agent) {
        const agent = step.agent;
        const agentInput = step.input
          ? await step.input(params.buildContext({ state: attemptState }))
          : { prompt: "" };

        const { prompt, ...agentOpts } = agentInput;

        // Run the step's agent inside a nested frame so observe-all does NOT
        // also self-route it as a standalone trace — the workflow already
        // captures it into report.steps (explicit capture, like the supervisor).
        const result = await withoutRunFrame(() =>
          agent.execute(prompt, {
            ...agentOpts,
            signal,
          }),
        );

        executionResult = result;

        if (result.usage) {
          mergeUsage(params.usage, result.usage);
        }

        if (result.error) throw result.error;
      } else if (step.run) {
        executionResult = await step.run(params.buildContext({ state: attemptState }));
      }

      if (step.output) {
        const extracted = await step.output.extract(
          params.buildContext({
            state: attemptState,
            agentResult: executionResult,
          }),
        );
        output = await validateSchema(step.output.schema, extracted);
      } else {
        output = undefined;
      }

      if (step.after) {
        await step.after(
          params.buildContext({
            state: attemptState,
            agentResult: executionResult,
          }),
        );
      }

      Object.assign(stepState, attemptState);

      attempts.push({
        index: attempt,
        startedAt: attemptStart,
        endedAt: new Date().toISOString(),
        duration: performance.now() - attemptStartPerf,
        status: "success",
      });
      succeeded = true;
      break;
    } catch (err) {
      if (isAbortError(err) || err instanceof WorkflowCancelledError) {
        throw createCancelledError(signal);
      }

      attempts.push({
        index: attempt,
        startedAt: attemptStart,
        endedAt: new Date().toISOString(),
        duration: performance.now() - attemptStartPerf,
        status: "failed",
        error: toAIError(err),
      });

      lastError = err;

      const shouldRetry =
        attempt < totalAttempts &&
        (retryConfig.retryOn ? retryConfig.retryOn(err, attempt) !== false : true);

      if (!shouldRetry) break;

      emitter.emit(
        "workflow.step.retrying",
        {
          step: step.name,
          attempt: attempt + 1,
          totalAttempts,
          lastError: err,
        },
        params.executionHandlers,
      );

      step.on?.retrying?.({
        step: step.name,
        attempt: attempt + 1,
        totalAttempts,
        lastError: err,
      });

      logger.warn(logModule, "step.retrying", `${step.name} step retrying`, {
        step: step.name,
        attempt: attempt + 1,
      });

      retryConfig.onRetry?.(attempt + 1, err);

      const delay = resolveBackoff(attempt, retryConfig.backoff);
      if (delay > 0) await sleep(delay, signal);
    }
  }

  const endedAt = new Date().toISOString();
  const duration = performance.now() - stepStartPerf;

  if (!succeeded) {
    const aiError = toAIError(lastError);
    const stepError = new StepFailedError(
      `step "${step.name}" failed after ${attempts.length} attempt(s): ${aiError.message}`,
      { stepName: step.name, attempts: attempts.length, cause: aiError },
    );

    emitter.emit(
      "workflow.step.failed",
      { step: step.name, error: stepError, attempts: attempts.length },
      params.executionHandlers,
    );

    step.on?.failed?.({
      step: step.name,
      error: stepError,
      attempts: attempts.length,
    });

    logger.error(logModule, "step.failed", `${step.name} step failed`, {
      step: step.name,
      attempts: attempts.length,
      code: stepError.code,
    });

    const failedAgentResult = asAgentResult(executionResult);
    return {
      output: undefined,
      skipped: false,
      status: "failed",
      startedAt,
      endedAt,
      duration,
      attempts: attempts.length,
      attemptHistory: attempts,
      error: stepError,
      state: stepState,
      executionResult:
        executionResult && typeof executionResult === "object" ? executionResult : undefined,
      agentReport: failedAgentResult?.report,
      agentUsage: failedAgentResult?.usage,
    };
  }

  emitter.emit(
    "workflow.step.completed",
    { step: step.name, output, duration },
    params.executionHandlers,
  );
  step.on?.completed?.({ step: step.name, output, duration });
  logger.debug(logModule, "step.completed", "step completed", {
    step: step.name,
    duration,
  });

  const completedAgentResult = asAgentResult(executionResult);
  return {
    output,
    skipped: false,
    status: "completed",
    startedAt,
    endedAt,
    duration,
    attempts: attempts.length,
    attemptHistory: attempts,
    state: stepState,
    executionResult:
      executionResult && typeof executionResult === "object" ? executionResult : undefined,
    agentReport: completedAgentResult?.report,
    agentUsage: completedAgentResult?.usage,
  };
}

// ---------------------------------------------------------------------------
// Parallel runner
// ---------------------------------------------------------------------------

type ParallelParams = ExecuteStepParams & {
  stepState: Record<string, unknown>;
  startedAt: string;
  startPerf: number;
};

async function runParallelStep(params: ParallelParams): Promise<MutableStepSnapshot> {
  const { step, emitter, executionHandlers, logger, logModule, signal } = params;

  const sharedState = params.stepState;
  const childSnapshots: Record<string, StepSnapshot> = {};
  let firstError: AIError | undefined;

  const results = await Promise.all(
    (step.parallel ?? []).map(async (child) => {
      const snap = await executeStep({
        step: child,
        state: sharedState,
        emitter,
        executionHandlers,
        logger,
        logModule,
        signal,
        buildContext: params.buildContext,
        usage: params.usage,
      });

      return { child, snap };
    }),
  );

  // Merge each child's resulting state into the shared parent state in
  // DECLARATION order — not completion order. Every child cloned the
  // same initial `sharedState` synchronously at dispatch, so the merge
  // here is the only thing that decides conflicting keys; `Promise.all`
  // preserves input order in `results`, so a key written by multiple
  // children deterministically resolves to the last-declared child's
  // value regardless of which settled first (C3). An optional
  // `mergeState` reducer overrides this per key for advanced workflows.
  for (const { child, snap } of results) {
    childSnapshots[child.name] = finalizeSnapshot(snap);

    if (step.mergeState) {
      step.mergeState(sharedState, snap.state, child.name);
    } else {
      Object.assign(sharedState, snap.state);
    }

    if (snap.status === "failed" && !firstError && snap.error) {
      firstError = snap.error;
    }
  }

  const endedAt = new Date().toISOString();
  const duration = performance.now() - params.startPerf;

  let output: unknown;

  if (step.output) {
    try {
      const ctx = params.buildContext({ state: sharedState });
      const ctxWithChildren = {
        ...ctx,
        steps: {
          ...ctx.steps,
          [step.name]: {
            ...(childSnapshots as unknown as StepSnapshot),
            steps: childSnapshots,
            status: firstError ? "failed" : "completed",
          } as StepSnapshot,
        } as Readonly<Record<string, StepSnapshot>>,
      };

      const extracted = await step.output.extract(ctxWithChildren);
      output = await validateSchema(step.output.schema, extracted);
    } catch (err) {
      firstError = firstError ?? toAIError(err);
    }
  }

  const status: "completed" | "failed" = firstError ? "failed" : "completed";

  if (status === "completed") {
    emitter.emit(
      "workflow.step.completed",
      { step: step.name, output, duration },
      executionHandlers,
    );
    step.on?.completed?.({ step: step.name, output, duration });
  } else {
    emitter.emit(
      "workflow.step.failed",
      { step: step.name, error: firstError!, attempts: 1 },
      executionHandlers,
    );
    step.on?.failed?.({ step: step.name, error: firstError!, attempts: 1 });
  }

  return {
    output,
    skipped: false,
    status,
    startedAt: params.startedAt,
    endedAt,
    duration,
    attempts: 1,
    attemptHistory: [],
    error: firstError,
    state: sharedState,
    steps: childSnapshots,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function finalizeSnapshot(snap: MutableStepSnapshot): StepSnapshot {
  return Object.freeze({
    output: snap.output,
    skipped: snap.skipped,
    status: snap.status,
    startedAt: snap.startedAt,
    endedAt: snap.endedAt,
    duration: snap.duration,
    attempts: snap.attempts,
    attemptHistory: snap.attemptHistory,
    error: snap.error,
    state: deepFreeze(cloneState(snap.state)),
    executionResult: snap.executionResult as StepSnapshot["executionResult"],
    agentReport: snap.agentReport,
    agentUsage: snap.agentUsage,
    steps: snap.steps,
  }) as StepSnapshot;
}

function buildFailedSnapshot(
  step: StepDefinition,
  state: Record<string, unknown>,
  startedAt: string,
  startPerf: number,
  attemptsCount: number,
  attemptHistory: AttemptEntry[],
): MutableStepSnapshot {
  const endedAt = new Date().toISOString();
  const duration = performance.now() - startPerf;
  const lastErr = attemptHistory[attemptHistory.length - 1]?.error;
  const wrapped = lastErr
    ? new StepFailedError(`step "${step.name}" skip threw: ${lastErr.message}`, {
        stepName: step.name,
        attempts: attemptsCount,
        cause: lastErr,
      })
    : new StepFailedError(`step "${step.name}" failed`, {
        stepName: step.name,
        attempts: attemptsCount,
      });

  return {
    output: undefined,
    skipped: false,
    status: "failed",
    startedAt,
    endedAt,
    duration,
    attempts: attemptsCount,
    attemptHistory,
    error: wrapped,
    state,
  };
}

function failedAttempt(
  index: number,
  err: unknown,
  startedAt: string,
  startPerf: number,
): AttemptEntry {
  return {
    index,
    startedAt,
    endedAt: new Date().toISOString(),
    duration: performance.now() - startPerf,
    status: "failed",
    error: toAIError(err),
  };
}

export function toAIError(err: unknown): AIError {
  if (err instanceof AIError) return err;
  if (err instanceof Error) return new WorkflowError(err.message, { cause: err });
  return new WorkflowError(String(err));
}

async function validateSchema(
  schema: StandardSchemaV1<unknown> | undefined,
  value: unknown,
): Promise<unknown> {
  if (!schema) return value;
  const result = await schema["~standard"].validate(value);

  if ("issues" in result && result.issues) {
    throw new SchemaValidationError("workflow step output failed schema validation", {
      issues: result.issues,
    });
  }

  return (result as { value: unknown }).value;
}
