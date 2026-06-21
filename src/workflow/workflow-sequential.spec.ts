import { describe, expect, it, vi } from "vitest";
import { StepFailedError } from "../errors";
import { mockAgent } from "../mock/mock-agent";
import { numberSchema } from "./_test-helpers";
import { step } from "./step";
import { workflow } from "./workflow";

describe("ai.workflow — execute overloads", () => {
  it("accepts (input, options) two-arg form", async () => {
    const wf = workflow<{ ticket: string }>({
      name: "two-arg",
      steps: [
        step({
          name: "a",
          run: ctx => {
            expect((ctx.input as { ticket: string }).ticket).toBe("hi");
          },
        }),
      ],
    });

    const result = await wf.execute({ ticket: "hi" }, { runId: "r-two" });
    expect(result.error).toBeUndefined();
    expect(result.report.runId).toBe("r-two");
  });

  it("accepts single-arg combined form with `input` key", async () => {
    const wf = workflow<{ ticket: string }>({
      name: "one-arg",
      steps: [
        step({
          name: "a",
          run: ctx => {
            expect((ctx.input as { ticket: string }).ticket).toBe("hi");
          },
        }),
      ],
    });

    const result = await wf.execute({
      input: { ticket: "hi" },
      runId: "r-one",
    });
    expect(result.error).toBeUndefined();
    expect(result.report.runId).toBe("r-one");
  });
});

describe("ai.workflow — sequential engine (1.2)", () => {
  it("executes steps in declared order", async () => {
    const order: string[] = [];

    const wf = workflow({
      name: "linear",
      steps: [
        step({ name: "a", run: () => order.push("a") }),
        step({ name: "b", run: () => order.push("b") }),
        step({ name: "c", run: () => order.push("c") }),
      ],
    });

    const result = await wf.execute({ input: {} });

    expect(result.error).toBeUndefined();
    expect(result.report.status).toBe("completed");
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("provides ctx.input and makes prior step output accessible", async () => {
    let seenInput: unknown;
    let seenPriorOutput: unknown;

    const wf = workflow({
      name: "inputs",
      steps: [
        step({
          name: "one",
          run: ctx => {
            seenInput = ctx.input;
            return "A";
          },
          output: {
            extract: ctx => (ctx as any).agentResult ?? ctx.state.__last ?? "A",
          },
        }),
        step({
          name: "two",
          run: ctx => {
            seenPriorOutput = ctx.steps.one?.output;
          },
        }),
      ],
    });

    await wf.execute({ input: { hello: "world" } });

    expect(seenInput).toEqual({ hello: "world" });
    expect(seenPriorOutput).toBe("A");
  });

  it("ctx.state is committed after step completion", async () => {
    const wf = workflow({
      name: "state",
      steps: [
        step({
          name: "write",
          run: ctx => {
            ctx.state.value = 42;
          },
        }),
        step({
          name: "read",
          run: ctx => {
            expect(ctx.state.value).toBe(42);
          },
        }),
      ],
    });

    const result = await wf.execute({ input: {} });

    expect(result.error).toBeUndefined();
    expect(result.report.state.value).toBe(42);
  });

  it("skip bypasses run/after and marks step skipped", async () => {
    const spy = vi.fn();

    const wf = workflow({
      name: "skip",
      steps: [
        step({
          name: "skipme",
          skip: () => true,
          run: spy,
          after: spy,
        }),
      ],
    });

    const result = await wf.execute({ input: {} });

    expect(spy).not.toHaveBeenCalled();
    expect(result.report.steps.skipme.status).toBe("skipped");
    expect(result.report.steps.skipme.skipped).toBe(true);
    expect(result.report.steps.skipme.output).toBeUndefined();
  });

  it("populates ctx.agentResult for steps with an agent", async () => {
    const myAgent = mockAgent({
      name: "caller",
      responses: [{ content: "hi", finishReason: "stop" }],
    });

    let seen: unknown;
    const wf = workflow({
      name: "agent-step",
      steps: [
        step({
          name: "call",
          agent: myAgent,
          input: () => ({ prompt: "go" }),
          output: { extract: ctx => ctx.agentResult?.text },
          after: ctx => {
            seen = ctx.agentResult?.text;
          },
        }),
      ],
    });

    const result = await wf.execute({ input: {} });
    expect(seen).toBe("hi");
    expect(result.report.steps.call.output).toBe("hi");
  });

  it("threads agent reports from steps into report.children[] (Phase 3.1)", async () => {
    const a = mockAgent({
      name: "one",
      responses: [{ content: "first", finishReason: "stop" }],
    });
    const b = mockAgent({
      name: "two",
      responses: [{ content: "second", finishReason: "stop" }],
    });

    const wf = workflow({
      name: "two-agents",
      steps: [
        step({ name: "s1", agent: a, input: () => ({ prompt: "x" }) }),
        step({ name: "s2", agent: b, input: () => ({ prompt: "y" }) }),
      ],
    });

    const result = await wf.execute({ input: {} });

    expect(result.error).toBeUndefined();
    expect(result.report.type).toBe("workflow");
    expect(result.report.children).toHaveLength(2);
    expect(result.report.children.every(c => c.type === "agent")).toBe(true);
    expect(result.report.children.map(c => c.name)).toEqual(["one", "two"]);
  });

  it("schema validation failure in output surfaces as step error", async () => {
    const wf = workflow({
      name: "bad-schema",
      steps: [
        step({
          name: "one",
          run: () => ({ n: "not a number" }),
          output: {
            extract: ctx => (ctx as any).agentResult ?? { n: "nope" },
            schema: numberSchema,
          },
        }),
      ],
    });

    const result = await wf.execute({ input: {} });

    expect(result.error).toBeInstanceOf(StepFailedError);
    expect(result.report.steps.one.status).toBe("failed");
    expect((result.report.steps.one.error as any)?.cause?.code).toBe(
      "SCHEMA_VALIDATION_FAILED",
    );
  });

  it("workflow.output.extract + schema honored", async () => {
    const wf = workflow({
      name: "out",
      steps: [step({ name: "one", run: ctx => (ctx.state.total = 7) })],
      output: {
        extract: ctx => ({ n: ctx.state.total }),
        schema: numberSchema,
      },
    });

    const result = await wf.execute({ input: {} });
    expect(result.data).toEqual({ n: 7 });
    expect(result.error).toBeUndefined();
  });

  it("execute never throws — errors are in result.error", async () => {
    const wf = workflow({
      name: "boom",
      steps: [
        step({
          name: "bad",
          run: () => {
            throw new Error("nope");
          },
        }),
      ],
    });

    const result = await wf.execute({ input: {} });
    expect(result.error).toBeDefined();
    expect(result.report.status).toBe("failed");
  });

  it("report has ISO timestamps + numeric duration", async () => {
    const wf = workflow({
      name: "timing",
      steps: [step({ name: "x", run: () => {} })],
    });

    const result = await wf.execute({ input: {} });
    expect(typeof result.report.startedAt).toBe("string");
    expect(typeof result.report.endedAt).toBe("string");
    expect(result.report.duration).toBeGreaterThanOrEqual(0);
    expect(result.report.signature).toMatch(/^[0-9a-f]{8}$/);
    expect(result.report.runId).toBeDefined();
  });
});
