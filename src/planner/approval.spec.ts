import { describe, expect, it } from "vitest";
import type { PlannerPlan } from "../contracts/planner/planner-plan.type";
import { PlannerPlanInvalidError } from "../errors/planner-plan-invalid-error";
import { planner } from "./planner";
import { fakeCapability, fakePlanningAgent } from "./test-support/planner-fakes";

/**
 * Coverage for the plan-only / execute-on-approval gate — `mode:
 * "plan-only"` returns the validated plan WITHOUT executing
 * (`status: "awaiting-approval"`), and a follow-up `approvedPlan` skips
 * generation and runs the supplied plan.
 */
describe("ai.planner — plan-only approval gate", () => {
  it("mode: plan-only returns the plan, executes nothing, status awaiting-approval", async () => {
    const plan: PlannerPlan = {
      steps: [
        { capability: "a", input: "1" },
        { capability: "b", input: "2" },
      ],
    };

    const a = fakeCapability("a", [{ data: "A" }]);
    const b = fakeCapability("b", [{ data: "B" }]);

    const instance = planner({
      name: "plan-only",
      planner: fakePlanningAgent([plan]),
      capabilities: [a, b],
    });

    const result = await instance.execute("go", { mode: "plan-only" });

    expect(result.report.status).toBe("awaiting-approval");
    expect(result.plan?.steps).toHaveLength(2);
    // Nothing executed — no step snapshots, no capability dispatches.
    expect(result.report.executedSteps).toHaveLength(0);
    expect(a.inputs).toHaveLength(0);
    expect(b.inputs).toHaveLength(0);
    expect(result.error).toBeUndefined();
  });

  it("approvedPlan skips generation and executes the supplied plan", async () => {
    const approved: PlannerPlan = { steps: [{ capability: "a", input: "run" }] };

    // The planning agent would return a DIFFERENT plan — if it were called
    // the test would observe "ghost"; it must not be.
    const planningAgent = fakePlanningAgent([{ steps: [{ capability: "a", input: "ghost" }] }]);
    const a = fakeCapability("a", [{ data: "DONE" }]);

    const instance = planner({
      name: "approved",
      planner: planningAgent,
      capabilities: [a],
    });

    const result = await instance.execute("go", { approvedPlan: approved });

    // Generation was skipped entirely.
    expect(planningAgent.calls).toBe(0);
    expect(result.report.status).toBe("completed");
    expect(a.inputs[0]).toContain("run");
    expect(result.report.plan?.steps[0].input).toBe("run");
  });

  it("approvedPlan wins over a contradictory mode: plan-only", async () => {
    const approved: PlannerPlan = { steps: [{ capability: "a", input: "exec" }] };
    const a = fakeCapability("a", [{ data: "DONE" }]);

    const instance = planner({
      name: "approved-and-plan-only",
      planner: fakePlanningAgent([approved]),
      capabilities: [a],
    });

    const result = await instance.execute("go", {
      approvedPlan: approved,
      mode: "plan-only",
    });

    // approvedPlan wins — the plan is executed, not held for approval.
    expect(result.report.status).toBe("completed");
    expect(a.inputs).toHaveLength(1);
  });

  it("a stale approvedPlan naming an unknown capability fails validation", async () => {
    const stale: PlannerPlan = { steps: [{ capability: "removed", input: "x" }] };

    const instance = planner({
      name: "stale-approved",
      planner: fakePlanningAgent([{ steps: [{ capability: "a", input: "y" }] }]),
      capabilities: [fakeCapability("a", [{ data: "A" }])],
    });

    const result = await instance.execute("go", { approvedPlan: stale });

    expect(result.error).toBeInstanceOf(PlannerPlanInvalidError);
    expect(result.error?.message).toMatch(/unknown capability "removed"/);
    expect(result.report.status).toBe("failed");
    expect(result.report.executedSteps).toHaveLength(0);
  });

  it("an empty approvedPlan fails validation without executing", async () => {
    const instance = planner({
      name: "empty-approved",
      planner: fakePlanningAgent([{ steps: [{ capability: "a", input: "y" }] }]),
      capabilities: [fakeCapability("a", [{ data: "A" }])],
    });

    const result = await instance.execute("go", { approvedPlan: { steps: [] } });

    expect(result.error).toBeInstanceOf(PlannerPlanInvalidError);
    expect(result.report.status).toBe("failed");
  });

  it("plan-only validates the plan before holding it (stale capability still fails)", async () => {
    const instance = planner({
      name: "plan-only-invalid",
      planner: fakePlanningAgent([{ steps: [{ capability: "ghost", input: "x" }] }]),
      capabilities: [fakeCapability("a", [{ data: "A" }])],
    });

    const result = await instance.execute("go", { mode: "plan-only" });

    // The generated plan references an unknown capability → invalid, NOT
    // awaiting-approval.
    expect(result.error).toBeInstanceOf(PlannerPlanInvalidError);
    expect(result.report.status).toBe("failed");
  });
});
