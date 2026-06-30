import type { PlannerStep } from "../contracts/planner/planner-plan.type";
import { PlannerPlanInvalidError } from "../errors/planner-plan-invalid-error";

/**
 * One node in the planner's execution DAG — a plan step plus the
 * resolved structural metadata the scheduler needs to order it.
 *
 * `id` is the step's own `id` when present, falling back to the step's
 * array index stringified (exactly as {@link PlannerStep.id} documents).
 * `dependencies` is the resolved set of node ids this step waits on,
 * de-duplicated and self-references dropped.
 */
export type DagNode = {
  /** Stable id — the step's own `id`, or its array index as a string. */
  id: string;
  /** 0-based position of the step in the original plan array. */
  index: number;
  /** The plan step this node schedules. */
  step: PlannerStep;
  /** Resolved ids this step depends on (subset of the DAG's node ids). */
  dependencies: string[];
};

/**
 * The built execution DAG — the ordered node list plus the lookups the
 * scheduler walks. Ordering follows the original plan array so a
 * dependency-free plan executes in author order, level by level.
 */
export type PlannerDag = {
  /** Nodes in original plan order. */
  nodes: DagNode[];
  /** id → node, for dependency resolution and sink detection. */
  byId: Map<string, DagNode>;
  /** id → ids of the nodes that depend on it (reverse edges). */
  dependents: Map<string, string[]>;
};

/**
 * Build the execution DAG from a plan's steps.
 *
 * Each step's `id` (falling back to its array index) and its `dependsOn`
 * become an adjacency list. A `dependsOn` that names a step not in the
 * plan, or any dependency cycle, raises a typed
 * {@link PlannerPlanInvalidError} BEFORE any step runs — the same error
 * class `generatePlan` uses for an unusable plan, with forensic context.
 *
 * @throws PlannerPlanInvalidError on a duplicate id, an unknown
 *   `dependsOn` target, or a cycle.
 */
export function buildDag(steps: PlannerStep[], plannerName = "planner"): PlannerDag {
  const nodes: DagNode[] = [];
  const byId = new Map<string, DagNode>();

  // Pass 1 — assign every step a stable id (own id or array index) and
  // index the nodes. Duplicate explicit ids are a malformed plan.
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index] as PlannerStep;
    const id = step.id ?? String(index);

    if (byId.has(id)) {
      throw new PlannerPlanInvalidError(
        `ai.planner("${plannerName}"): duplicate step id "${id}" in DAG plan`,
        { context: { id } },
      );
    }

    const node: DagNode = { id, index, step, dependencies: [] };
    nodes.push(node);
    byId.set(id, node);
  }

  // Pass 2 — resolve dependencies against the id set; reject unknowns,
  // dedupe, and drop self-references (a no-op edge, never a cycle).
  const dependents = new Map<string, string[]>();

  for (const node of nodes) {
    const seen = new Set<string>();

    for (const dependency of node.step.dependsOn ?? []) {
      if (dependency === node.id) {
        continue;
      }

      if (!byId.has(dependency)) {
        throw new PlannerPlanInvalidError(
          `ai.planner("${plannerName}"): step "${node.id}" depends on unknown step "${dependency}"`,
          { context: { id: node.id, dependency } },
        );
      }

      if (seen.has(dependency)) {
        continue;
      }

      seen.add(dependency);
      node.dependencies.push(dependency);

      const reverse = dependents.get(dependency) ?? [];
      reverse.push(node.id);
      dependents.set(dependency, reverse);
    }
  }

  assertAcyclic(nodes, byId, plannerName);

  return { nodes, byId, dependents };
}

/**
 * Compute the next ready set: nodes not yet done whose every dependency
 * is in `completed`. Preserves original plan order so a level dispatches
 * deterministically. A node whose dependency is `unreachable` (a failed
 * or skipped ancestor) is NOT ready — it never becomes ready and is
 * recorded skipped by the caller.
 */
export function readyNodes(
  dag: PlannerDag,
  completed: ReadonlySet<string>,
  done: ReadonlySet<string>,
): DagNode[] {
  return dag.nodes.filter(
    (node) =>
      !done.has(node.id) &&
      node.dependencies.every((dependency) => completed.has(dependency)),
  );
}

/**
 * The topological sink(s) — nodes nothing depends on. Used to define the
 * "final output" under parallelism: with an `output` schema set, a
 * single sink is the unambiguous final step; multiple sinks are a
 * convergence error the caller surfaces.
 */
export function sinkNodes(dag: PlannerDag): DagNode[] {
  return dag.nodes.filter((node) => (dag.dependents.get(node.id) ?? []).length === 0);
}

/**
 * Depth-first cycle detection over the dependency edges. A back-edge to
 * a node on the current recursion stack means a cycle — raised as a
 * typed {@link PlannerPlanInvalidError} naming the offending node.
 */
function assertAcyclic(
  nodes: DagNode[],
  byId: Map<string, DagNode>,
  plannerName: string,
): void {
  const VISITING = 1;
  const DONE = 2;
  const state = new Map<string, number>();

  const visit = (node: DagNode): void => {
    const current = state.get(node.id);

    if (current === DONE) {
      return;
    }

    if (current === VISITING) {
      throw new PlannerPlanInvalidError(
        `ai.planner("${plannerName}"): dependency cycle detected at step "${node.id}"`,
        { context: { id: node.id } },
      );
    }

    state.set(node.id, VISITING);

    for (const dependency of node.dependencies) {
      visit(byId.get(dependency) as DagNode);
    }

    state.set(node.id, DONE);
  };

  for (const node of nodes) {
    visit(node);
  }
}
