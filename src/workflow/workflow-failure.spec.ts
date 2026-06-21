import { describe, expect, it, vi } from "vitest";
import type { WorkflowSnapshot } from "../contracts/workflow/workflow-snapshot.type";
import { RoutingError, StepFailedError } from "../errors";
import { memory as snapshotMemory } from "../snapshot/memory";
import { step } from "./step";
import { workflow } from "./workflow";

function makeStore() {
  return snapshotMemory<WorkflowSnapshot>();
}

describe("ai.workflow — failure halts + onFailure recovery", () => {
  it("halts the workflow when a step's retries are exhausted (downstream steps don't run)", async () => {
    const order: string[] = [];

    const wf = workflow({
      name: "halt",
      steps: [
        step({
          name: "a",
          run: () => order.push("a"),
        }),
        step({
          name: "b",
          retry: { attempts: 2, backoff: "none" },
          run: () => {
            order.push("b");
            throw new Error("boom");
          },
        }),
        step({
          name: "c",
          run: () => order.push("c"),
        }),
      ],
    });

    const result = await wf.execute({ input: {} });

    expect(order).toEqual(["a", "b", "b"]);
    expect(result.error).toBeInstanceOf(StepFailedError);
    expect(result.report.status).toBe("failed");
    expect(result.report.steps.b.status).toBe("failed");
    expect(result.report.steps.c).toBeUndefined();
  });

  it("does NOT call nextStep on a failed step", async () => {
    const nextSpy = vi.fn();

    const wf = workflow({
      name: "no-next-on-fail",
      steps: [
        step({
          name: "a",
          run: () => {
            throw new Error("nope");
          },
          nextStep: nextSpy,
        }),
        step({ name: "b", run: () => {} }),
      ],
    });

    const result = await wf.execute({ input: {} });

    expect(nextSpy).not.toHaveBeenCalled();
    expect(result.report.status).toBe("failed");
  });

  it("checkpoints the failed step name as `next` so resume re-runs it", async () => {
    const store = makeStore();

    const wf = workflow({
      name: "halt-checkpoint",
      snapshotStore: store,
      steps: [
        step({ name: "a", run: ctx => (ctx.state.a = 1) }),
        step({
          name: "b",
          run: () => {
            throw new Error("fail");
          },
        }),
      ],
    });

    await wf.execute({ input: {}, runId: "halt-1" });
    const snap = await store.load("halt-1");

    expect(snap!.next).toBe("b");
    expect(snap!.status).toBe("failed");
    expect(snap!.state).toMatchObject({ a: 1 });
  });

  it("resume after failure re-runs the failed step and continues", async () => {
    const store = makeStore();
    let failOnce = true;
    const aCalls = vi.fn();

    function makeWf() {
      return workflow({
        name: "resume-after-fail",
        snapshotStore: store,
        steps: [
          step({ name: "a", run: aCalls }),
          step({
            name: "b",
            run: () => {
              if (failOnce) {
                failOnce = false;
                throw new Error("transient");
              }
            },
          }),
          step({ name: "c", run: () => {} }),
        ],
      });
    }

    const wf1 = makeWf();
    const result1 = await wf1.execute({ input: {}, runId: "rf-1" });
    expect(result1.report.status).toBe("failed");

    const wf2 = makeWf();
    const result2 = await wf2.resume("rf-1");

    expect(result2.report.status).toBe("completed");
    expect(result2.report.steps.b.status).toBe("completed");
    expect(result2.report.steps.c.status).toBe("completed");
    // Step "a" should NOT re-run on resume — it completed before the failure.
    expect(aCalls).toHaveBeenCalledTimes(1);
  });

  it("onFailure goto recovers the workflow (final status: completed)", async () => {
    const order: string[] = [];

    const wf = workflow({
      name: "recovery-goto",
      steps: [
        step({
          name: "primary",
          run: () => {
            order.push("primary");
            throw new Error("primary fail");
          },
          onFailure: () => ({ goto: "fallback" }),
        }),
        step({
          name: "fallback",
          run: () => order.push("fallback"),
        }),
      ],
    });

    const result = await wf.execute({ input: {} });

    expect(order).toEqual(["primary", "fallback"]);
    expect(result.report.status).toBe("completed");
    expect(result.error).toBeUndefined();
    // Failed step's snapshot retains the failure for forensic trace.
    expect(result.report.steps.primary.status).toBe("failed");
    expect(result.report.steps.primary.error).toBeInstanceOf(StepFailedError);
    expect(result.report.steps.fallback.status).toBe("completed");
  });

  it("onFailure end:true stops cleanly (final status: completed, no error)", async () => {
    const order: string[] = [];

    const wf = workflow({
      name: "recovery-end",
      steps: [
        step({
          name: "primary",
          run: () => {
            throw new Error("over budget");
          },
          onFailure: () => ({ end: true }),
        }),
        step({
          name: "downstream",
          run: () => order.push("downstream"),
        }),
      ],
    });

    const result = await wf.execute({ input: {} });

    expect(order).toEqual([]);
    expect(result.report.status).toBe("completed");
    expect(result.error).toBeUndefined();
  });

  it("onFailure returning void halts (same as no onFailure)", async () => {
    const onFailure = vi.fn(() => undefined);

    const wf = workflow({
      name: "recovery-void",
      steps: [
        step({
          name: "primary",
          run: () => {
            throw new Error("nope");
          },
          onFailure,
        }),
        step({ name: "downstream", run: () => {} }),
      ],
    });

    const result = await wf.execute({ input: {} });

    expect(onFailure).toHaveBeenCalledOnce();
    expect(result.report.status).toBe("failed");
    expect(result.error).toBeInstanceOf(StepFailedError);
    expect(result.report.steps.downstream).toBeUndefined();
  });

  it("onFailure receives the failed step's error", async () => {
    const captured = vi.fn();

    const wf = workflow({
      name: "onfail-error",
      steps: [
        step({
          name: "primary",
          run: () => {
            throw new Error("inner cause");
          },
          onFailure: (_, error) => {
            captured(error);
          },
        }),
      ],
    });

    await wf.execute({ input: {} });

    expect(captured).toHaveBeenCalledOnce();
    const err = captured.mock.calls[0]![0] as StepFailedError;
    expect(err).toBeInstanceOf(StepFailedError);
    expect(err.message).toContain("primary");
  });

  it("a throw inside onFailure terminates with RoutingError (not retried)", async () => {
    const wf = workflow({
      name: "onfail-throws",
      steps: [
        step({
          name: "primary",
          run: () => {
            throw new Error("step fail");
          },
          onFailure: () => {
            throw new Error("router fail");
          },
        }),
      ],
    });

    const result = await wf.execute({ input: {} });

    expect(result.error).toBeInstanceOf(RoutingError);
    expect(result.report.status).toBe("failed");
  });

  it("onFailure goto to an unknown step throws RoutingError", async () => {
    const wf = workflow({
      name: "onfail-bad-target",
      steps: [
        step({
          name: "primary",
          run: () => {
            throw new Error("fail");
          },
          onFailure: () => ({ goto: "doesNotExist" }),
        }),
      ],
    });

    const result = await wf.execute({ input: {} });

    expect(result.error).toBeInstanceOf(RoutingError);
    expect(result.report.status).toBe("failed");
  });

  it("recovered failure: checkpoint records `next` as the recovery target", async () => {
    const store = makeStore();

    const wf = workflow({
      name: "recover-checkpoint",
      snapshotStore: store,
      steps: [
        step({
          name: "primary",
          run: () => {
            throw new Error("fail");
          },
          onFailure: () => ({ goto: "fallback" }),
        }),
        step({ name: "fallback", run: () => {} }),
      ],
    });

    await wf.execute({ input: {}, runId: "recov-1" });
    // The final snapshot reflects the completed run.
    const snap = await store.load("recov-1");
    expect(snap!.status).toBe("completed");
    expect(snap!.steps.primary.status).toBe("failed");
    expect(snap!.steps.fallback.status).toBe("completed");
  });

  it("parallel: one child fails — all siblings still settle, workflow halts after the group", async () => {
    const order: string[] = [];

    const wf = workflow({
      name: "parallel-halt",
      steps: [
        step({
          name: "group",
          parallel: [
            step({
              name: "child-a",
              run: async () => {
                order.push("a");
              },
            }),
            step({
              name: "child-b",
              run: async () => {
                order.push("b");
                throw new Error("b fail");
              },
            }),
            step({
              name: "child-c",
              run: async () => {
                order.push("c");
              },
            }),
          ],
        }),
        step({
          name: "downstream",
          run: () => order.push("downstream"),
        }),
      ],
    });

    const result = await wf.execute({ input: {} });

    // All three children settled (last-write-wins, atomic group).
    expect(order.sort()).toEqual(["a", "b", "c"]);
    expect(result.report.status).toBe("failed");
    expect(result.report.steps.group.status).toBe("failed");
    // child-a and child-c remain reachable via flat path even though parent failed.
    expect(result.report.steps["child-a"].status).toBe("completed");
    expect(result.report.steps["child-c"].status).toBe("completed");
    expect(result.report.steps["child-b"].status).toBe("failed");
    // Downstream did not run.
    expect(result.report.steps.downstream).toBeUndefined();
  });

  it("parallel: parent step's onFailure can recover after group settles", async () => {
    const order: string[] = [];

    const wf = workflow({
      name: "parallel-recover",
      steps: [
        step({
          name: "group",
          parallel: [
            step({ name: "p-a", run: () => order.push("a") }),
            step({
              name: "p-b",
              run: () => {
                throw new Error("b");
              },
            }),
          ],
          onFailure: () => ({ goto: "fallback" }),
        }),
        step({
          name: "fallback",
          run: () => order.push("fallback"),
        }),
      ],
    });

    const result = await wf.execute({ input: {} });

    expect(order).toContain("a");
    expect(order).toContain("fallback");
    expect(result.report.status).toBe("completed");
    expect(result.error).toBeUndefined();
  });
});

describe("ai.workflow — ctx.startedAt", () => {
  it("ctx.startedAt is a Date instance", async () => {
    let captured: unknown;

    const wf = workflow({
      name: "started-at",
      steps: [
        step({
          name: "a",
          run: ctx => {
            captured = ctx.startedAt;
          },
        }),
      ],
    });

    await wf.execute({ input: {} });

    expect(captured).toBeInstanceOf(Date);
    // Sanity check: within the last few seconds.
    expect(Date.now() - (captured as Date).getTime()).toBeLessThan(5000);
  });

  it("ctx.startedAt is stable across resume (carries the original start)", async () => {
    const store = makeStore();
    let firstStart: Date | undefined;
    let resumedStart: Date | undefined;
    let failOnce = true;

    function makeWf() {
      return workflow({
        name: "started-at-resume",
        snapshotStore: store,
        steps: [
          step({
            name: "a",
            run: ctx => {
              if (firstStart === undefined) firstStart = ctx.startedAt;
            },
          }),
          step({
            name: "b",
            run: ctx => {
              if (failOnce) {
                failOnce = false;
                throw new Error("transient");
              }
              resumedStart = ctx.startedAt;
            },
          }),
        ],
      });
    }

    const wf1 = makeWf();
    await wf1.execute({ input: {}, runId: "sa-1" });

    // Wait long enough that "now" is measurably different from the original start.
    await new Promise(r => setTimeout(r, 50));

    const wf2 = makeWf();
    await wf2.resume("sa-1");

    expect(firstStart).toBeInstanceOf(Date);
    expect(resumedStart).toBeInstanceOf(Date);
    expect(resumedStart!.getTime()).toBe(firstStart!.getTime());
  });
});
