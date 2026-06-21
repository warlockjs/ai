import type { StepDefinition } from "../contracts/workflow/step.contract";
import { WorkflowError } from "../errors";

/**
 * `ai.step(def)` — pass-through factory used for authoring. Returns
 * the definition object verbatim so the workflow engine can read it
 * during execution; the factory exists for API symmetry with
 * `ai.workflow()` and to leave room for future validation or
 * metadata annotation.
 *
 * Generics flow from the enclosing `ai.workflow<...>()` call when the
 * step is declared inline inside `steps: [...]`. To author a step
 * outside that context with full typing, pass them explicitly:
 * `ai.step<MyInput, MyState, MyContext>({ ... })`.
 */
export function step<
  TInput = unknown,
  TState = Record<string, unknown>,
  TContext = unknown,
>(
  definition: StepDefinition<TInput, TState, TContext>,
): StepDefinition<TInput, TState, TContext> {
  validate(definition);
  return definition;
}

function validate<TInput, TState, TContext>(
  def: StepDefinition<TInput, TState, TContext>,
): void {
  if (!def.name || typeof def.name !== "string") {
    throw new WorkflowError("ai.step: `name` is required");
  }

  const hasRun = typeof def.run === "function";
  const hasAgent = def.agent !== undefined;
  const hasParallel = Array.isArray(def.parallel) && def.parallel.length > 0;

  const modes = [hasRun, hasAgent, hasParallel].filter(Boolean).length;

  if (modes === 0) {
    throw new WorkflowError(
      `ai.step("${def.name}"): must define exactly one of run | agent | parallel`,
    );
  }

  if (modes > 1) {
    throw new WorkflowError(
      `ai.step("${def.name}"): define only one of run | agent | parallel`,
    );
  }

  if (hasAgent && typeof def.input !== "function") {
    throw new WorkflowError(
      `ai.step("${def.name}"): \`input(ctx)\` is required when \`agent\` is set`,
    );
  }
}
