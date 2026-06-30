import { describe, expect, it } from "vitest";
import type { PlannerStep } from "../contracts/planner/planner-plan.type";
import { PlannerPlanInvalidError } from "../errors/planner-plan-invalid-error";
import { buildDag, readyNodes, sinkNodes } from "./dag-scheduler";

/**
 * Unit coverage for the DAG scheduler primitives — `buildDag` adjacency
 * construction + cycle/unknown-id rejection, `readyNodes` level
 * scheduling, and `sinkNodes` topological-sink detection. The
 * integration of these into parallel execution lives in
 * `dag-execution.spec.ts`.
 */
describe("dag-scheduler — buildDag", () => {
  it("falls back to the array index when a step has no id", () => {
    const steps: PlannerStep[] = [
      { capability: "a", input: "1" },
      { capability: "b", input: "2" },
    ];

    const dag = buildDag(steps);

    expect(dag.nodes.map((node) => node.id)).toEqual(["0", "1"]);
    expect(dag.nodes.map((node) => node.index)).toEqual([0, 1]);
  });

  it("resolves explicit ids and dependsOn into adjacency + reverse edges", () => {
    const steps: PlannerStep[] = [
      { id: "search", capability: "s", input: "find" },
      { id: "write", capability: "w", input: "draft", dependsOn: ["search"] },
    ];

    const dag = buildDag(steps);

    expect(dag.byId.get("write")?.dependencies).toEqual(["search"]);
    expect(dag.dependents.get("search")).toEqual(["write"]);
    expect(dag.dependents.get("write") ?? []).toEqual([]);
  });

  it("dedupes repeated dependsOn entries and drops self-references", () => {
    const steps: PlannerStep[] = [
      { id: "a", capability: "a", input: "1" },
      { id: "b", capability: "b", input: "2", dependsOn: ["a", "a", "b"] },
    ];

    const dag = buildDag(steps);

    expect(dag.byId.get("b")?.dependencies).toEqual(["a"]);
  });

  it("throws PlannerPlanInvalidError on a dependsOn naming an unknown step", () => {
    const steps: PlannerStep[] = [
      { id: "a", capability: "a", input: "1", dependsOn: ["ghost"] },
    ];

    expect(() => buildDag(steps, "p")).toThrow(PlannerPlanInvalidError);
    expect(() => buildDag(steps, "p")).toThrow(/unknown step "ghost"/);
  });

  it("throws PlannerPlanInvalidError on a duplicate explicit id", () => {
    const steps: PlannerStep[] = [
      { id: "dup", capability: "a", input: "1" },
      { id: "dup", capability: "b", input: "2" },
    ];

    expect(() => buildDag(steps, "p")).toThrow(/duplicate step id "dup"/);
  });

  it("throws PlannerPlanInvalidError on a dependency cycle", () => {
    const steps: PlannerStep[] = [
      { id: "a", capability: "a", input: "1", dependsOn: ["b"] },
      { id: "b", capability: "b", input: "2", dependsOn: ["a"] },
    ];

    expect(() => buildDag(steps, "p")).toThrow(/dependency cycle/);
  });
});

describe("dag-scheduler — readyNodes", () => {
  it("returns root steps first, then unblocks dependents as deps complete", () => {
    const steps: PlannerStep[] = [
      { id: "a", capability: "a", input: "1" },
      { id: "b", capability: "b", input: "2" },
      { id: "c", capability: "c", input: "3", dependsOn: ["a", "b"] },
    ];
    const dag = buildDag(steps);

    const first = readyNodes(dag, new Set(), new Set());
    expect(first.map((node) => node.id)).toEqual(["a", "b"]);

    // After only "a" completes, "c" is still blocked on "b".
    const afterA = readyNodes(dag, new Set(["a"]), new Set(["a"]));
    expect(afterA.map((node) => node.id)).toEqual(["b"]);

    // Both deps done → "c" is ready.
    const afterBoth = readyNodes(dag, new Set(["a", "b"]), new Set(["a", "b"]));
    expect(afterBoth.map((node) => node.id)).toEqual(["c"]);
  });

  it("never marks a node ready while a dependency is unreached (failed/skipped)", () => {
    const steps: PlannerStep[] = [
      { id: "a", capability: "a", input: "1" },
      { id: "b", capability: "b", input: "2", dependsOn: ["a"] },
    ];
    const dag = buildDag(steps);

    // "a" is done but NOT completed (it failed) → "b" never becomes ready.
    const ready = readyNodes(dag, new Set(), new Set(["a"]));
    expect(ready).toHaveLength(0);
  });
});

describe("dag-scheduler — sinkNodes", () => {
  it("identifies the single step nothing depends on", () => {
    const steps: PlannerStep[] = [
      { id: "a", capability: "a", input: "1" },
      { id: "b", capability: "b", input: "2", dependsOn: ["a"] },
    ];

    const sinks = sinkNodes(buildDag(steps));
    expect(sinks.map((node) => node.id)).toEqual(["b"]);
  });

  it("returns multiple sinks for a fan-out plan", () => {
    const steps: PlannerStep[] = [
      { id: "root", capability: "r", input: "0" },
      { id: "left", capability: "l", input: "1", dependsOn: ["root"] },
      { id: "right", capability: "r2", input: "2", dependsOn: ["root"] },
    ];

    const sinks = sinkNodes(buildDag(steps));
    expect(sinks.map((node) => node.id).sort()).toEqual(["left", "right"]);
  });
});
