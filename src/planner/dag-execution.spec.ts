import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import type { PlannerPlan } from "../contracts/planner/planner-plan.type";
import { PlannerPlanInvalidError } from "../errors/planner-plan-invalid-error";
import { planner } from "./planner";
import {
  concurrencyCapability,
  fakeCapability,
  fakePlanningAgent,
  makeConcurrencyState,
} from "./test-support/planner-fakes";

/**
 * Integration coverage for `dag: true` — the planner schedules
 * independent `dependsOn` branches in parallel, feeds each step only its
 * dependencies' outputs, respects `maxConcurrency`, and defines the
 * final output as the topological sink.
 */
describe("ai.planner — DAG execution", () => {
  it("runs independent steps in parallel and the dependent step after them", async () => {
    const plan: PlannerPlan = {
      steps: [
        { id: "a", capability: "a", input: "do-a" },
        { id: "b", capability: "b", input: "do-b" },
        { id: "c", capability: "c", input: "do-c", dependsOn: ["a", "b"] },
      ],
    };

    const instance = planner({
      name: "dag-basic",
      planner: fakePlanningAgent([plan]),
      dag: true,
      capabilities: [
        fakeCapability("a", [{ data: "A" }]),
        fakeCapability("b", [{ data: "B" }]),
        fakeCapability("c", [{ data: "C" }]),
      ],
    });

    const result = await instance.execute("go");

    expect(result.error).toBeUndefined();
    expect(result.report.status).toBe("completed");
    expect(result.report.executedSteps.map((step) => step.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
  });

  it("feeds each step ONLY its dependencies' outputs (scoped input wiring)", async () => {
    const a = fakeCapability("a", [{ data: "OUT-A" }]);
    const b = fakeCapability("b", [{ data: "OUT-B" }]);
    const c = fakeCapability("c", [{ data: "OUT-C" }]);

    const plan: PlannerPlan = {
      steps: [
        { id: "a", capability: "a", input: "ia" },
        { id: "b", capability: "b", input: "ib" },
        { id: "c", capability: "c", input: "ic", dependsOn: ["a"] },
      ],
    };

    const instance = planner({
      name: "dag-wiring",
      planner: fakePlanningAgent([plan]),
      dag: true,
      capabilities: [a, b, c],
    });

    await instance.execute("go");

    // Roots see no upstream context — just their raw input.
    expect(a.inputs[0]).toBe("ia");
    expect(b.inputs[0]).toBe("ib");
    // "c" depends only on "a", so it sees OUT-A but NOT OUT-B.
    expect(c.inputs[0]).toContain("OUT-A");
    expect(c.inputs[0]).not.toContain("OUT-B");
    expect(c.inputs[0]).toContain("ic");
  });

  it("respects maxConcurrency when more steps are ready than the cap", async () => {
    const state = makeConcurrencyState();

    const plan: PlannerPlan = {
      steps: [
        { id: "a", capability: "a", input: "1" },
        { id: "b", capability: "b", input: "2" },
        { id: "c", capability: "c", input: "3" },
        { id: "d", capability: "d", input: "4" },
      ],
    };

    const instance = planner({
      name: "dag-concurrency",
      planner: fakePlanningAgent([plan]),
      dag: true,
      maxConcurrency: 2,
      capabilities: [
        concurrencyCapability("a", state),
        concurrencyCapability("b", state),
        concurrencyCapability("c", state),
        concurrencyCapability("d", state),
      ],
    });

    await instance.execute("go");

    expect(state.peak).toBeLessThanOrEqual(2);
    expect(state.peak).toBeGreaterThan(1);
  });

  it("uses the topological sink as the final output for an output schema", async () => {
    const schema: StandardSchemaV1<string> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) =>
          typeof value === "string"
            ? { value }
            : { issues: [{ message: "string required" }] },
      },
    };

    const plan: PlannerPlan = {
      steps: [
        { id: "a", capability: "a", input: "1" },
        { id: "b", capability: "b", input: "2", dependsOn: ["a"] },
      ],
    };

    const instance = planner<string>({
      name: "dag-sink",
      planner: fakePlanningAgent([plan]),
      dag: true,
      output: schema,
      capabilities: [
        fakeCapability("a", [{ data: "A" }]),
        fakeCapability("b", [{ data: "SINK-OUTPUT" }]),
      ],
    });

    const result = await instance.execute("go");

    expect(result.error).toBeUndefined();
    expect(result.data).toBe("SINK-OUTPUT");
  });

  it("errors when the DAG has multiple sinks while an output schema is set", async () => {
    const schema: StandardSchemaV1<string> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) =>
          typeof value === "string"
            ? { value }
            : { issues: [{ message: "string required" }] },
      },
    };

    const plan: PlannerPlan = {
      steps: [
        { id: "root", capability: "a", input: "0" },
        { id: "left", capability: "b", input: "1", dependsOn: ["root"] },
        { id: "right", capability: "c", input: "2", dependsOn: ["root"] },
      ],
    };

    const instance = planner<string>({
      name: "dag-multi-sink",
      planner: fakePlanningAgent([plan]),
      dag: true,
      output: schema,
      capabilities: [
        fakeCapability("a", [{ data: "R" }]),
        fakeCapability("b", [{ data: "L" }]),
        fakeCapability("c", [{ data: "Ri" }]),
      ],
    });

    const result = await instance.execute("go");

    expect(result.error).toBeInstanceOf(PlannerPlanInvalidError);
    expect(result.error?.message).toMatch(/multiple sinks/);
    expect(result.data).toBeUndefined();
  });

  it("fails the run with a typed error on a cyclic DAG plan", async () => {
    const plan: PlannerPlan = {
      steps: [
        { id: "a", capability: "a", input: "1", dependsOn: ["b"] },
        { id: "b", capability: "b", input: "2", dependsOn: ["a"] },
      ],
    };

    const instance = planner({
      name: "dag-cycle",
      planner: fakePlanningAgent([plan]),
      dag: true,
      capabilities: [fakeCapability("a"), fakeCapability("b")],
    });

    const result = await instance.execute("go");

    expect(result.error).toBeInstanceOf(PlannerPlanInvalidError);
    expect(result.report.status).toBe("failed");
  });

  it("a failed step blocks only its descendants; independent branches still settle", async () => {
    const plan: PlannerPlan = {
      steps: [
        { id: "a", capability: "a", input: "1" },
        { id: "b", capability: "b", input: "2", dependsOn: ["a"] },
        { id: "c", capability: "c", input: "3" },
      ],
    };

    const instance = planner({
      name: "dag-partial-fail",
      planner: fakePlanningAgent([plan]),
      dag: true,
      capabilities: [
        fakeCapability("a", [{ error: new PlannerPlanInvalidError("a boom") }]),
        fakeCapability("b", [{ data: "B" }]),
        fakeCapability("c", [{ data: "C" }]),
      ],
    });

    const result = await instance.execute("go");

    const byCapability = new Map(
      result.report.executedSteps.map((step) => [step.step.capability, step.status]),
    );
    expect(byCapability.get("a")).toBe("failed");
    // "c" is independent of "a" → it still completes.
    expect(byCapability.get("c")).toBe("completed");
    // "b" depends on the failed "a" → skipped, never dispatched.
    expect(byCapability.get("b")).toBe("skipped");
    expect(result.report.status).toBe("failed");
  });

  it("truncates DAG steps beyond maxSteps as skipped", async () => {
    const plan: PlannerPlan = {
      steps: [
        { id: "a", capability: "a", input: "1" },
        { id: "b", capability: "a", input: "2" },
        { id: "c", capability: "a", input: "3" },
      ],
    };

    const instance = planner({
      name: "dag-capped",
      planner: fakePlanningAgent([plan]),
      dag: true,
      maxSteps: 1,
      capabilities: [fakeCapability("a", [{ data: "ok" }])],
    });

    const result = await instance.execute("go");

    const skipped = result.report.executedSteps.filter((step) => step.status === "skipped");
    expect(skipped.length).toBe(2);
  });
});
