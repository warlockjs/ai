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
