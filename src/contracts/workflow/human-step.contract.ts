import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { NextStepResult } from "./next-step-result.type";
import type { StepDefinition } from "./step.contract";
import type { WorkflowContext } from "./workflow-context.type";

/**
 * A workflow step that SUSPENDS the run and waits for human input,
 * resuming via `workflow.resume(runId, { resumeWith })`. While
 * suspended the workflow surfaces the non-terminal `awaiting-input`
 * status upstream (orchestrator.md §19; workflow.md §15).
 *
 * This is a `StepDefinition`-derived variant — NOT a free-standing
 * `{ name, prompt }` object — discriminated by `type: "human"`. It
 * reuses the standard step lifecycle hooks (`skip` / `before` /
 * `nextStep` / `onCancel` / `on`) and adds the suspend/resume surface:
 * a `prompt` shown to the reviewer, a `resumeSchema` the resume payload
 * is validated against, and an `apply` hook that merges the human's
 * payload back into `ctx.state` on resume.
 *
 * @remarks
 * **v2 — not yet exported.** Per backlog.md, workflow.md §15, and
 * orchestrator.md §19, `ai.humanStep()` is deferred to v2 (it needs
 * orchestrator-level durable suspension/resumption). This type is the
 * design-consistent TARGET shape, not the shipped surface; the workflow
 * barrel intentionally keeps it unexported and the `StepDefinition`
 * union does not yet admit it.
 *
 * **Open design item (needs sign-off):** the exact resume field names
 * (`resumeWith` / `resumeSchema` / `apply`) are a v2 design choice — see
 * `domains/design/open-questions.md`. The locked direction is the
 * `StepDefinition`-derived suspend-step STRUCTURE; the field names are
 * provisional.
 *
 * @example
 * const reviewStep: HumanStepContract<{ approved: boolean }> = {
 *   name: "humanReview",
 *   type: "human",
 *   prompt: "Review the draft and approve or reject.",
 *   resumeSchema: v.object({ approved: v.boolean() }),
 *   apply: (ctx, resumeWith) => {
 *     ctx.state.approved = resumeWith.approved;
 *   },
 * };
 */
export type HumanStepContract<
  TResume = unknown,
  TInput = unknown,
  TState = Record<string, unknown>,
  TContext = unknown,
> = {
  /** Unique step name (`StepDefinition.name` parity). */
  name: string;
  /** Marks this as a human-input suspend step (discriminator). */
  type: "human";
  /** Prompt/instructions shown to the reviewer; may read `ctx`. */
  prompt:
    | string
    | ((
        ctx: WorkflowContext<TInput, TState, TContext>,
      ) => string | Promise<string>);
  /** Schema the resume payload (`resume(runId, { resumeWith })`) is validated against. */
  resumeSchema?: StandardSchemaV1<TResume>;
  /** Applies the human's resume payload back into `ctx.state` on resume. */
  apply?: (
    ctx: WorkflowContext<TInput, TState, TContext>,
    resumeWith: TResume,
  ) => void | Promise<void>;
  /** Optional auto-resolution window when no human responds (ms). */
  timeoutMs?: number;
  /** Routing decision when `timeoutMs` elapses without a resume. */
  onTimeout?: (
    ctx: WorkflowContext<TInput, TState, TContext>,
  ) => NextStepResult | Promise<NextStepResult>;

  // Reused StepDefinition lifecycle hooks (all optional).
  skip?: StepDefinition<TInput, TState, TContext>["skip"];
  before?: StepDefinition<TInput, TState, TContext>["before"];
  nextStep?: StepDefinition<TInput, TState, TContext>["nextStep"];
  onCancel?: StepDefinition<TInput, TState, TContext>["onCancel"];
  on?: StepDefinition<TInput, TState, TContext>["on"];
};
