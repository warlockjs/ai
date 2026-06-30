import { describe, expect, it } from "vitest";
import type { PlannerPlan } from "../contracts/planner/planner-plan.type";
import { planner } from "./planner";
import { fakeCapability, fakePlanningAgent } from "./test-support/planner-fakes";

/**
 * Coverage for adaptive re-planning — an `onStep` `replan` directive (or,
 * with `config.replan` set, an unhandled failure) regenerates the
 * REMAINING plan instead of aborting, bounded by `maxReplans`.
 */
describe("ai.planner — adaptive re-planning", () => {
  it("an onStep replan directive regenerates the remaining plan", async () => {
    const first: PlannerPlan = { steps: [{ capability: "a", input: "first" }] };
    const revised: PlannerPlan = { steps: [{ capability: "b", input: "revised" }] };

    const planningAgent = fakePlanningAgent([first, revised]);

    const instance = planner({
      name: "replan-directive",
      planner: planningAgent,
      replan: { maxReplans: 2 },
      capabilities: [
        fakeCapability("a", [{ data: "A" }]),
        fakeCapability("b", [{ data: "B" }]),
      ],
    });

    let replanned = false;

    const result = await instance.execute("go", {
      onStep: (snapshot) => {
        // Ask for a replan exactly once, after the first step completes.
        if (!replanned && snapshot.step.capability === "a") {
          replanned = true;
          return { type: "replan", feedback: "use b instead" };
        }

        return undefined;
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.report.status).toBe("completed");
    // The planning agent was asked twice (initial + one replan).
    expect(planningAgent.calls).toBe(2);
    // The capability from the revised plan actually ran.
    const ran = result.report.executedSteps.filter((step) => step.status === "completed");
    expect(ran.some((step) => step.step.capability === "b")).toBe(true);
    // The replan prompt carried the feedback.
    expect(planningAgent.prompts[1]).toContain("use b instead");
  });

  it("auto-replans on an unhandled failure when config.replan is set", async () => {
    const first: PlannerPlan = { steps: [{ capability: "flaky", input: "try" }] };
    const recovery: PlannerPlan = { steps: [{ capability: "stable", input: "recover" }] };

    const planningAgent = fakePlanningAgent([first, recovery]);

    const instance = planner({
      name: "auto-replan",
      planner: planningAgent,
      replan: { maxReplans: 1 },
      capabilities: [
        fakeCapability("flaky", [{ error: new Error("flaked") as never }]),
        fakeCapability("stable", [{ data: "recovered" }]),
      ],
    });

    const result = await instance.execute("go");

    // The failure triggered an automatic replan, and the recovery ran.
    expect(planningAgent.calls).toBe(2);
    expect(result.report.status).toBe("completed");
    expect(result.data).toBe("recovered");
  });

  it("caps regeneration at maxReplans, then ends with the last failure", async () => {
    const failingPlan: PlannerPlan = { steps: [{ capability: "flaky", input: "x" }] };

    // Every regeneration returns another failing plan.
    const planningAgent = fakePlanningAgent([failingPlan]);

    const instance = planner({
      name: "replan-cap",
      planner: planningAgent,
      replan: { maxReplans: 2 },
      capabilities: [fakeCapability("flaky", [{ error: new Error("always fails") as never }])],
    });

    const result = await instance.execute("go");

    // initial + 2 replans = 3 planning calls, then it gives up.
    expect(planningAgent.calls).toBe(3);
    expect(result.report.status).toBe("failed");
    expect(result.error).toBeDefined();
  });

  it("without replan config, a failure aborts exactly as today (regression)", async () => {
    const plan: PlannerPlan = {
      steps: [
        { capability: "flaky", input: "1" },
        { capability: "never", input: "2" },
      ],
    };

    const planningAgent = fakePlanningAgent([plan]);

    const instance = planner({
      name: "no-replan",
      planner: planningAgent,
      capabilities: [
        fakeCapability("flaky", [{ error: new Error("boom") as never }]),
        fakeCapability("never", [{ data: "unreached" }]),
      ],
    });

    const result = await instance.execute("go");

    // No regeneration — one planning call only.
    expect(planningAgent.calls).toBe(1);
    expect(result.report.status).toBe("failed");
    expect(result.report.executedSteps[0].status).toBe("failed");
    expect(result.report.executedSteps[1].status).toBe("skipped");
  });

  it("an onStep abort directive stops the run and skips the rest", async () => {
    const plan: PlannerPlan = {
      steps: [
        { capability: "a", input: "1" },
        { capability: "b", input: "2" },
      ],
    };

    const instance = planner({
      name: "abort-directive",
      planner: fakePlanningAgent([plan]),
      capabilities: [
        fakeCapability("a", [{ data: "A" }]),
        fakeCapability("b", [{ data: "B" }]),
      ],
    });

    const result = await instance.execute("go", {
      onStep: (snapshot) =>
        snapshot.step.capability === "a" ? { type: "abort" } : undefined,
    });

    expect(result.report.executedSteps[0].status).toBe("completed");
    expect(result.report.executedSteps[1].status).toBe("skipped");
  });
});
