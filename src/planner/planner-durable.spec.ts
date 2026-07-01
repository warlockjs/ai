import { describe, expect, it, vi } from "vitest";
import type { PlannerCapability } from "../contracts/planner/planner-capability.type";
import type { PlannerPlan } from "../contracts/planner/planner-plan.type";
import type { PlannerSnapshot } from "../contracts/planner/planner-snapshot.type";
import type { BaseReport } from "../contracts/result/base-report.type";
import { PlannerDriftError } from "../errors";
import { MockSDK } from "../mock/mock-sdk";
import { memory as snapshotMemory } from "../snapshot/memory";
import { planner } from "./planner";

/** Typed in-memory snapshot store for these planner durable tests. */
function plannerStore() {
  return snapshotMemory<PlannerSnapshot>();
}

// ---------------------------------------------------------------------------
// Test capability: a spy-able executable whose `execute()` THROWS on its
// first invocation while `shouldFail` is true (simulating a mid-node
// crash), then succeeds once the failure is "fixed". Tracks invocation
// count so a resume can assert which nodes re-ran.
// ---------------------------------------------------------------------------

type FlakyCapability = PlannerCapability & {
  calls: () => number;
  setShouldFail: (value: boolean) => void;
};

function flakyCapability(name: string, output: string): FlakyCapability {
  let shouldFail = false;
  const spy = vi.fn();

  const report: BaseReport = {
    runId: `${name}-run`,
    rootRunId: `${name}-run`,
    name,
    type: "agent",
    status: "completed",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    duration: 1,
    usage: { input: 10, output: 5, total: 15 },
    children: [],
  };

  const capability: PlannerCapability = {
    name,
    description: `capability ${name}`,
    executable: {
      name,
      async execute(_input: string) {
        spy();

        if (shouldFail) {
          throw new Error(`boom: ${name} crashed`);
        }

        return {
          type: "agent" as const,
          data: output,
          text: output,
          usage: { input: 10, output: 5, total: 15 },
          report,
        };
      },
    } as unknown as PlannerCapability["executable"],
  };

  return {
    ...capability,
    calls: () => spy.mock.calls.length,
    setShouldFail: (value: boolean) => {
      shouldFail = value;
    },
  };
}

/** A model that returns `plan` as JSON for the planning trip. */
function planModel(plan: PlannerPlan) {
  return MockSDK({
    responses: [{ content: JSON.stringify(plan), finishReason: "stop" }],
  }).model({ name: "mock-planner" });
}

const sequentialPlan: PlannerPlan = {
  summary: "a then b",
  steps: [
    { capability: "a", input: "do a" },
    { capability: "b", input: "do b" },
  ],
};

describe("ai.planner — durable mid-run crash-resume", () => {
  it("checkpoints per node and resumes only the unfinished frontier", async () => {
    const store = plannerStore();
    const a = flakyCapability("a", "out-a");
    const b = flakyCapability("b", "out-b");
    b.setShouldFail(true); // node b crashes on the first run

    const research = planner({
      name: "research",
      model: planModel(sequentialPlan),
      capabilities: [a, b],
      durable: { store },
    });

    // First run — node a completes + checkpoints, node b crashes.
    const first = await research.execute("compare A vs B", { runId: "plan-1" });

    expect(first.error).toBeDefined();
    expect(first.report.status).toBe("failed");
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);

    // A snapshot exists carrying node a's completed ledger entry.
    const snapshot = await store.load("plan-1");
    expect(snapshot).toBeDefined();
    expect(snapshot!.executedSteps).toHaveLength(1);
    expect(snapshot!.executedSteps[0].status).toBe("completed");
    expect(snapshot!.executedSteps[0].step.capability).toBe("a");

    // Fix the failure cause, then resume.
    b.setShouldFail(false);
    const recovered = await research.resume("plan-1");

    // (a) Only the failed-and-after node (b) re-ran.
    expect(recovered.error).toBeUndefined();
    expect(recovered.report.status).toBe("completed");

    // (b) The earlier capability (a) was NOT re-invoked.
    expect(a.calls()).toBe(1);
    // b ran once (crashed) on the first run + once on resume.
    expect(b.calls()).toBe(2);

    // The resumed run did NOT re-call the planning LLM — the plan is frozen.
    expect(recovered.report.plan?.summary).toBe("a then b");
    // Both nodes are recorded completed in the final ledger.
    expect(recovered.report.executedSteps.map((entry) => entry.status)).toEqual([
      "completed",
      "completed",
    ]);
  });

  it("does not double-count usage across a resume", async () => {
    const store = plannerStore();
    const a = flakyCapability("a", "out-a");
    const b = flakyCapability("b", "out-b");
    b.setShouldFail(true);

    const research = planner({
      name: "usage-research",
      model: planModel(sequentialPlan),
      capabilities: [a, b],
      durable: { store },
    });

    await research.execute("go", { runId: "plan-usage" });

    const snapshot = await store.load("plan-usage");
    const usageAfterCrash = snapshot!.usage.total;

    b.setShouldFail(false);
    const recovered = await research.resume("plan-usage");

    // Node a's usage (15) + the planning trip's usage are counted exactly
    // once: the resumed total exceeds the post-crash total by only node b's
    // contribution (15), never re-adding node a or re-running the planner.
    expect(recovered.usage.total).toBe(usageAfterCrash + 15);
  });

  it("re-seeds a DAG resume to schedule only the unfinished frontier", async () => {
    const store = plannerStore();
    const a = flakyCapability("a", "out-a");
    const b = flakyCapability("b", "out-b");
    b.setShouldFail(true);

    // DAG plan: b depends on a. b crashes; a is the completed prefix.
    const dagPlan: PlannerPlan = {
      summary: "dag a -> b",
      steps: [
        { id: "a", capability: "a", input: "do a" },
        { id: "b", capability: "b", input: "do b", dependsOn: ["a"] },
      ],
    };

    const research = planner({
      name: "dag-research",
      model: planModel(dagPlan),
      capabilities: [a, b],
      dag: true,
      durable: { store },
    });

    const first = await research.execute("go", { runId: "plan-dag" });
    expect(first.report.status).toBe("failed");
    expect(a.calls()).toBe(1);

    b.setShouldFail(false);
    const recovered = await research.resume("plan-dag");

    expect(recovered.report.status).toBe("completed");
    // a (the completed prefix) was not re-dispatched on resume.
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(2);
  });

  it("short-circuits a completed-run resume to the stored result", async () => {
    const store = plannerStore();
    const a = flakyCapability("a", "out-a");
    const b = flakyCapability("b", "out-b");

    const research = planner({
      name: "completer",
      model: planModel(sequentialPlan),
      capabilities: [a, b],
      durable: { store },
    });

    const first = await research.execute("go", { runId: "plan-done" });
    expect(first.report.status).toBe("completed");

    const aCalls = a.calls();
    const bCalls = b.calls();

    const resumed = await research.resume("plan-done");

    // Re-returned the stored result without re-dispatching any capability.
    expect(resumed.report.status).toBe("completed");
    expect(a.calls()).toBe(aCalls);
    expect(b.calls()).toBe(bCalls);
  });

  it("refuses to resume against a drifted definition unless forced", async () => {
    const store = plannerStore();
    const a = flakyCapability("a", "out-a");
    const b = flakyCapability("b", "out-b");

    const research = planner({
      name: "drifter",
      model: planModel(sequentialPlan),
      capabilities: [a, b],
      durable: { store },
    });

    await research.execute("go", { runId: "plan-drift" });

    // A structurally different planner — an extra capability changes the
    // signature.
    const c = flakyCapability("c", "out-c");
    const drifted = planner({
      name: "drifter",
      model: planModel(sequentialPlan),
      capabilities: [
        flakyCapability("a", "out-a"),
        flakyCapability("b", "out-b"),
        c,
      ],
      durable: { store },
    });

    await expect(drifted.resume("plan-drift")).rejects.toBeInstanceOf(PlannerDriftError);

    const forced = await drifted.resume("plan-drift", { force: true });
    expect(forced.report.status).toBe("completed");
  });

  it("is a no-op without `durable` — no snapshot written", async () => {
    const store = plannerStore();
    const a = flakyCapability("a", "out-a");
    const b = flakyCapability("b", "out-b");

    const research = planner({
      name: "plain",
      model: planModel(sequentialPlan),
      capabilities: [a, b],
    });

    const result = await research.execute("go", { runId: "plan-plain" });

    expect(result.report.status).toBe("completed");
    expect(await store.load("plan-plain")).toBeUndefined();
  });
});
