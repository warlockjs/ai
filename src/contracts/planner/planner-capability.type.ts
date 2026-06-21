import type { ExecutableContract } from "../executable.contract";
import type { BaseResult } from "../result/base-result.type";

/**
 * A single capability the planner may reference in a generated plan.
 *
 * **Role.** Adapts an arbitrary executable primitive (an
 * `AgentContract`, `WorkflowInstance`, `SupervisorContract`,
 * `ToolContract`, or anything satisfying {@link ExecutableContract})
 * into a uniform unit the planner can describe to the LLM and dispatch
 * during plan execution. The `name` is the stable handle the LLM
 * references in each plan step; the `description` is what the LLM reads
 * to decide WHEN to use it.
 *
 * **Why a wrapper and not the bare executable?** Two reasons. The LLM
 * needs a `name` + `description` pair regardless of whether the
 * underlying primitive carries one, and the planner needs a single
 * `execute(input)` entry point with a `string` input contract so plan
 * steps stay uniform across heterogeneous capabilities.
 */
export type PlannerCapability = {
  /** Stable handle the LLM references in each plan step. Unique per planner. */
  name: string;
  /**
   * What this capability does — the "when would the planner pick this?"
   * line. Injected verbatim into the plan-generation prompt so the LLM
   * can select capabilities sensibly.
   */
  description: string;
  /**
   * The underlying executable. Dispatched with the step's resolved
   * `string` input during plan execution; its `usage` and `report`
   * roll up into the planner's unified result.
   */
  executable: ExecutableContract<string, unknown, BaseResult>;
};
