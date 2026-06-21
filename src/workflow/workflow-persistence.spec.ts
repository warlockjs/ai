import { describe, expect, it } from "vitest";
import type { WorkflowSnapshot } from "../contracts/workflow/workflow-snapshot.type";
import { WorkflowDriftError } from "../errors";
import { memory as snapshotMemory } from "../snapshot/memory";
import { step } from "./step";
import { workflow } from "./workflow";

function makeStore() {
  return snapshotMemory<WorkflowSnapshot>();
}

describe("ai.workflow — persistence + resume (1.6)", () => {
  it("writes a snapshot after every step", async () => {
    const store = makeStore();
    const wf = workflow({
      name: "persist",
      snapshotStore: store,
      steps: [
        step({ name: "a", run: ctx => (ctx.state.a = 1) }),
        step({ name: "b", run: ctx => (ctx.state.b = 2) }),
      ],
    });

    const { report } = await wf.execute({ input: {}, runId: "r1" });
    const snap = await store.load("r1");

    expect(snap).toBeDefined();
    expect(snap!.signature).toBe(report.signature);
    expect(snap!.status).toBe("completed");
    expect(snap!.state).toMatchObject({ a: 1, b: 2 });
  });

  it("resume drift check throws WorkflowDriftError", async () => {
    const store = makeStore();

    const wf1 = workflow({
      name: "drift",
      snapshotStore: store,
      steps: [step({ name: "a", run: () => {} })],
    });
    await wf1.execute({ input: {}, runId: "r-drift" });

    const wf2 = workflow({
      name: "drift",
      snapshotStore: store,
      steps: [
        step({ name: "a", run: () => {} }),
        step({ name: "b", run: () => {} }),
      ],
    });

    await expect(wf2.resume("r-drift")).rejects.toBeInstanceOf(
      WorkflowDriftError,
    );
  });

  it("resume with force bypasses drift check", async () => {
    const store = makeStore();

    const wf1 = workflow({
      name: "force",
      snapshotStore: store,
      steps: [step({ name: "a", run: () => {} })],
    });
    await wf1.execute({ input: {}, runId: "r-force" });

    const wf2 = workflow({
      name: "force",
      snapshotStore: store,
      steps: [
        step({ name: "a", run: () => {} }),
        step({ name: "b", run: () => {} }),
      ],
    });

    const result = await wf2.resume("r-force", { force: true });
    expect(result.error).toBeUndefined();
  });

  it("resume continues from persisted state", async () => {
    const store = makeStore();
    let crash = true;

    const wf = () =>
      workflow({
        name: "crash",
        snapshotStore: store,
        steps: [
          step({
            name: "a",
            run: ctx => {
              ctx.state.a = "done";
            },
          }),
          step({
            name: "b",
            run: ctx => {
              if (crash) throw new Error("boom");
              ctx.state.b = "done";
            },
          }),
        ],
      });

    await wf().execute({ input: {}, runId: "r-crash" });
    crash = false;
    const result = await wf().resume("r-crash");

    expect(result.error).toBeUndefined();
    expect(result.report.state.b).toBe("done");
  });
});
