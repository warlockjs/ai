import type { NextStepResult } from "../contracts/workflow/next-step-result.type";
import type { StepDefinition } from "../contracts/workflow/step.contract";
import type { WorkflowContext } from "../contracts/workflow/workflow-context.type";
import type { WorkflowDefinition } from "../contracts/workflow/workflow.contract";
import { RoutingError } from "../errors";

/**
 * Resolve the next step to run after `step` completes. Tries
 * step-level `nextStep` first, then workflow-level, then falls
 * through (returns `undefined`, engine picks the next declared step).
 *
 * Throws `RoutingError` when either callback throws — routing is
 * authoritative, so a broken router terminates the workflow instead
 * of being retried.
 */
export async function resolveNextStep<T>(params: {
  step: StepDefinition;
  definition: WorkflowDefinition<any, T, any, any>;
  ctx: WorkflowContext;
}): Promise<"end" | string | undefined> {
  const { step, definition, ctx } = params;

  if (step.nextStep) {
    let outcome: NextStepResult;
    try {
      outcome = await step.nextStep(ctx);
    } catch (err) {
      throw new RoutingError(
        `workflow "${definition.name}": step "${step.name}" nextStep threw`,
        { stepName: step.name, cause: err },
      );
    }
    const mapped = mapNextStep(outcome);
    if (mapped !== undefined) return mapped;
  }

  if (definition.nextStep) {
    let outcome: NextStepResult;
    try {
      outcome = await definition.nextStep(step.name, ctx);
    } catch (err) {
      throw new RoutingError(
        `workflow "${definition.name}": workflow-level nextStep threw after "${step.name}"`,
        { stepName: step.name, cause: err },
      );
    }
    const mapped = mapNextStep(outcome);
    if (mapped !== undefined) return mapped;
  }

  return undefined;
}

export function mapNextStep(
  outcome: NextStepResult,
): "end" | string | undefined {
  if (!outcome) return undefined;
  if ("end" in outcome && outcome.end === true) return "end";
  if ("goto" in outcome && typeof outcome.goto === "string")
    return outcome.goto;
  return undefined;
}

export function nextDeclaredStep<T>(
  definition: WorkflowDefinition<any, T, any, any>,
  currentName: string,
): string | null {
  const idx = definition.steps.findIndex(s => s.name === currentName);
  if (idx === -1) return null;
  return definition.steps[idx + 1]?.name ?? null;
}
