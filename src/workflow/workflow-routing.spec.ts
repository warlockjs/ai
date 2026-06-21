import { describe, expect, it } from "vitest";
import { MaxStepsExceededError, RoutingError } from "../errors";
import { step } from "./step";
import { workflow } from "./workflow";

describe("ai.workflow — routing (1.5)", () => {
  it("step-level goto jumps to named step", async () => {
    const order: string[] = [];
    const wf = workflow({
      name: "goto",
      steps: [
        step({
          name: "a",
          run: () => order.push("a"),
          nextStep: () => ({ goto: "c" }),
        }),
        step({ name: "b", run: () => order.push("b") }),
        step({ name: "c", run: () => order.push("c") }),
      ],
    });

    await wf.execute({ input: {} });
    expect(order).toEqual(["a", "c"]);
  });

  it("end terminates the workflow", async () => {
    const order: string[] = [];
    const wf = workflow({
      name: "end",
      steps: [
        step({
          name: "a",
          run: () => order.push("a"),
          nextStep: () => ({ end: true }),
        }),
        step({ name: "b", run: () => order.push("b") }),
      ],
    });

    await wf.execute({ input: {} });
    expect(order).toEqual(["a"]);
  });

  it("workflow-level nextStep runs when step-level returns void", async () => {
    const order: string[] = [];
    const wf = workflow({
      name: "wf-level",
      steps: [
        step({ name: "a", run: () => order.push("a") }),
        step({ name: "b", run: () => order.push("b") }),
        step({ name: "c", run: () => order.push("c") }),
      ],
      nextStep: name => {
        if (name === "a") return { goto: "c" };
      },
    });

    await wf.execute({ input: {} });
    expect(order).toEqual(["a", "c"]);
  });

  it("invalid goto raises RoutingError", async () => {
    const wf = workflow({
      name: "bad-goto",
      steps: [
        step({
          name: "a",
          run: () => {},
          nextStep: () => ({ goto: "ghost" }),
        }),
      ],
    });

    const result = await wf.execute({ input: {} });
    expect(result.error).toBeInstanceOf(RoutingError);
    expect(result.report.status).toBe("failed");
  });

  it("maxSteps trips with MaxStepsExceededError", async () => {
    const wf = workflow({
      name: "loop",
      maxSteps: 5,
      steps: [
        step({
          name: "a",
          run: () => {},
          nextStep: () => ({ goto: "a" }),
        }),
      ],
    });

    const result = await wf.execute({ input: {} });
    expect(result.error).toBeInstanceOf(MaxStepsExceededError);
  });

  it("loopWarnAfter emits warning without stopping", async () => {
    const warnings: unknown[] = [];
    const wf = workflow({
      name: "warn",
      maxSteps: 10,
      loopWarnAfter: 3,
      on: {
        "workflow.loop.warning": p => warnings.push(p),
      },
      steps: [
        step({
          name: "a",
          run: ctx => {
            ctx.state.count = ((ctx.state.count as number) ?? 0) + 1;
          },
          nextStep: ctx =>
            (ctx.state.count as number) < 5 ? { goto: "a" } : { end: true },
        }),
      ],
    });

    const result = await wf.execute({ input: {} });
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.error).toBeUndefined();
  });

  it("nextStep error terminates with RoutingError", async () => {
    const wf = workflow({
      name: "router-boom",
      steps: [
        step({
          name: "a",
          run: () => {},
          nextStep: () => {
            throw new Error("router exploded");
          },
        }),
      ],
    });

    const result = await wf.execute({ input: {} });
    expect(result.error).toBeInstanceOf(RoutingError);
  });
});
