/**
 * One step of an LLM-generated execution plan.
 *
 * **Role.** The unit the planner executes in order. Each step names a
 * registered {@link PlannerCapability} (`capability`) and carries the
 * concrete `input` the LLM resolved for that capability. The optional
 * `id` / `dependsOn` fields let the LLM express a simple dependency
 * note for human readability; the bounded-v1 planner executes steps
 * strictly in array order and does NOT yet schedule on `dependsOn`
 * (see {@link PlannerPlan} remarks).
 */
export type PlannerStep = {
  /**
   * Stable id for this step within the plan — referenced by other
   * steps' `dependsOn`. Optional; the planner falls back to the array
   * index when absent.
   */
  id?: string;
  /** Name of the {@link PlannerCapability} this step dispatches. */
  capability: string;
  /** Concrete input the LLM resolved for the capability's `execute()`. */
  input: string;
  /** Free-form rationale the LLM produced for why this step exists. */
  reason?: string;
  /**
   * Ids of steps this step conceptually depends on. Advisory only in
   * bounded-v1 — recorded on the snapshot for forensics but not used
   * to reorder or parallelize execution.
   */
  dependsOn?: string[];
};

/**
 * The full ordered execution plan the planner's LLM produces before any
 * capability runs.
 *
 * @remarks
 * **Bounded v1.** Steps execute strictly in array order, one at a time.
 * `dependsOn` is advisory metadata only — no DAG scheduling, no
 * parallel fan-out, no mid-plan re-planning. Those are deferred (see
 * the planner skill). The earlier steps' outputs are threaded into the
 * later steps' prompt context so a downstream capability can build on
 * what ran before it.
 */
export type PlannerPlan = {
  /** The ordered steps to execute. At least one. */
  steps: PlannerStep[];
  /** Optional one-line LLM summary of the overall strategy. */
  summary?: string;
};
