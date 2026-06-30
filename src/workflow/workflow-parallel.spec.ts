import { describe, expect, it } from "vitest";
import { step } from "./step";
import { workflow } from "./workflow";

describe("ai.workflow — parallel (1.4)", () => {
  it("runs children concurrently and reports both", async () => {
    const wf = workflow({
      name: "par",
      steps: [
        step({
          name: "group",
          parallel: [
            step({
              name: "a",
              run: async ctx => {
                await new Promise(r => setTimeout(r, 5));
                ctx.state.a = 1;
              },
            }),
            step({
              name: "b",
              run: async ctx => {
                await new Promise(r => setTimeout(r, 5));
                ctx.state.b = 2;
              },
            }),
          ],
        }),
      ],
    });

    const result = await wf.execute({ input: {} });
    expect(result.error).toBeUndefined();
    expect(result.report.state.a).toBe(1);
    expect(result.report.state.b).toBe(2);
    expect(result.report.steps.group.steps?.a.status).toBe("completed");
    expect(result.report.steps.group.steps?.b.status).toBe("completed");
  });

  it("conflicting writes resolve in declaration order (last-declared wins), not completion order", async () => {
    // The first-declared child settles LAST (longer delay). Under a
    // completion-order merge the slow first child would win; under the
    // deterministic declaration-order merge the last-declared child wins
    // regardless of timing. This fails on the old `Object.assign`-per-
    // settle code and passes on the declaration-order merge (C3).
    const wf = workflow({
      name: "par-conflict",
      steps: [
        step({
          name: "group",
          parallel: [
            step({
              name: "slow-first",
              run: async ctx => {
                await new Promise(r => setTimeout(r, 25));
                ctx.state.winner = "first";
              },
            }),
            step({
              name: "fast-second",
              run: async ctx => {
                await new Promise(r => setTimeout(r, 1));
                ctx.state.winner = "second";
              },
            }),
          ],
        }),
      ],
    });

    const result = await wf.execute({ input: {} });
    expect(result.error).toBeUndefined();
    expect(result.report.state.winner).toBe("second");
  });

  it("mergeState reducer customizes parallel conflict resolution", async () => {
    const wf = workflow({
      name: "par-reduce",
      steps: [
        step({
          name: "group",
          mergeState: (acc, childState) => {
            acc.total =
              ((acc.total as number) ?? 0) + ((childState.total as number) ?? 0);
          },
          parallel: [
            step({
              name: "a",
              run: async ctx => {
                await new Promise(r => setTimeout(r, 10));
                ctx.state.total = 10;
              },
            }),
            step({
              name: "b",
              run: async ctx => {
                await new Promise(r => setTimeout(r, 1));
                ctx.state.total = 5;
              },
            }),
          ],
        }),
      ],
    });

    const result = await wf.execute({ input: {} });
    expect(result.error).toBeUndefined();
    expect(result.report.state.total).toBe(15);
  });

  it("first child failure surfaces as parent error; siblings still recorded", async () => {
    const wf = workflow({
      name: "par-fail",
      steps: [
        step({
          name: "group",
          parallel: [
            step({
              name: "a",
              run: () => {
                throw new Error("boom");
              },
            }),
            step({ name: "b", run: () => "ok" }),
          ],
        }),
      ],
    });

    const result = await wf.execute({ input: {} });
    expect(result.report.status).toBe("failed");
    expect(result.report.steps.group.status).toBe("failed");
    expect(result.report.steps.group.steps?.a.status).toBe("failed");
    expect(result.report.steps.group.steps?.b.status).toBe("completed");
  });
});
