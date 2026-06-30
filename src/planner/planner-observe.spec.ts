import { afterEach, describe, expect, it } from "vitest";
import { agent } from "../agent/agent";
import type { BaseReport } from "../contracts/result/base-report.type";
import type { PlannerPlan } from "../contracts/planner/planner-plan.type";
import { mockAgent } from "../mock/mock-agent";
import { MockSDK } from "../mock/mock-sdk";
import {
  clearObservers,
  registerObserver,
  setObserveAll,
} from "../observe/observer-registry";
import { planner } from "./planner";

/** A planning agent (model mode) whose single trip returns `plan` as JSON. */
function planModel(plan: PlannerPlan) {
  return MockSDK({
    responses: [{ content: JSON.stringify(plan), finishReason: "stop" }],
  }).model({ name: "mock-planner" });
}

/** A REAL capability agent — one that WOULD self-route under observe-all if
 * the planner didn't suppress it. */
function capabilityAgent(name: string, reply: string) {
  return agent({
    name,
    model: MockSDK({
      responses: [{ content: reply, finishReason: "stop" }],
    }).model({ name: `model-${name}` }),
  });
}

/**
 * Regression guard for the planner's observe-all routing (the "5 fragments"
 * bug). The planner spawns a planning trip plus one sub-agent per capability
 * step; each is a REAL executable that self-routes under observe-all. Before
 * the fix the planner never routed its OWN report and never suppressed the
 * children's self-routes, so observe-all saw N standalone sub-agent traces
 * and no planner. The fix routes the planner once and nests every sub-run.
 */
describe("ai.planner — observe-all routing + nesting", () => {
  afterEach(() => clearObservers());

  it("routes the planner ONCE with its planning trip + capability steps nested (no fragmentation)", async () => {
    const search = capabilityAgent("search-cap", "found three articles");
    const write = capabilityAgent("write-cap", "final summary");

    const plan: PlannerPlan = {
      summary: "search then write",
      steps: [
        { capability: "search", input: "find articles about X" },
        { capability: "write", input: "summarize the findings" },
      ],
    };

    const research = planner({
      name: "obs-planner",
      model: planModel(plan),
      capabilities: [
        { name: "search", description: "Search the web", executable: search },
        { name: "write", description: "Draft a summary", executable: write },
      ],
    });

    const collected: BaseReport[] = [];
    registerObserver({ collect: (report) => void collected.push(report as BaseReport) });
    setObserveAll(true);

    await research.execute("Research X");

    // Exactly ONE root report routed — the planner — never the planner plus a
    // standalone trace per sub-agent.
    expect(collected).toHaveLength(1);
    expect(collected[0].type).toBe("planner");

    // The planning trip and BOTH capability agents nest under it.
    const childNames = collected[0].children.map((child) => child.name);
    expect(childNames).toContain("obs-planner-planner"); // model-mode planning agent
    expect(childNames).toContain("search-cap");
    expect(childNames).toContain("write-cap");
  });

  it("stamps the terminal error onto a FAILED planner report so the observe path surfaces it", async () => {
    // An empty-steps plan is an invalid plan → the planner fails before
    // executing anything (PlannerPlanInvalidError).
    const failing = planner({
      name: "err-planner",
      model: planModel({ steps: [] }),
      capabilities: [
        { name: "a", description: "d", executable: mockAgent({ name: "a" }) },
      ],
    });

    const collected: BaseReport[] = [];
    registerObserver({ collect: (report) => void collected.push(report as BaseReport) });
    setObserveAll(true);

    const result = await failing.execute("goal");

    // The error rides on the report itself, not only on the result envelope —
    // so an observer (which never sees the envelope) still gets the cause.
    expect(result.report.status).toBe("failed");
    expect(result.report.error).toBeDefined();
    expect(collected).toHaveLength(1);
    expect(collected[0].status).toBe("failed");
    expect(collected[0].error).toBeDefined();
  });
});
