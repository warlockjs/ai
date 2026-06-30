import { afterEach, describe, expect, it } from "vitest";
import { END } from "../contracts/end.type";
import type { ExecutionReport } from "../contracts/result/execution-report.type";
import { buildScriptedAgent } from "../supervisor/_test-helpers";
import { supervisor } from "../supervisor/supervisor";
import { step } from "../workflow/step";
import { workflow } from "../workflow/workflow";
import { clearObservers } from "./observer-registry";
import type { Observer } from "./observer.contract";

/** A fake observer that records every report handed to it. */
function makeFakeObserver(): Observer & { collected: ExecutionReport[] } {
  const collected: ExecutionReport[] = [];

  return {
    collected,
    collect(report) {
      collected.push(report);
    },
  };
}

describe("flow observe — workflow", () => {
  afterEach(() => {
    clearObservers();
  });

  it("routes a workflow's report to a flow-local observer", async () => {
    const observer = makeFakeObserver();

    const wf = workflow({
      name: "observed-wf",
      observe: observer,
      steps: [step({ name: "a", run: () => undefined })],
    });

    const result = await wf.execute(undefined);

    expect(result.error).toBeUndefined();
    expect(observer.collected).toHaveLength(1);
    expect(observer.collected[0]?.type).toBe("workflow");
    expect(observer.collected[0]?.runId).toBe(result.report.runId);
  });

  it("does not route when observe is omitted (default off)", async () => {
    const observer = makeFakeObserver();

    const wf = workflow({
      name: "unobserved-wf",
      steps: [step({ name: "a", run: () => undefined })],
    });

    await wf.execute(undefined);

    expect(observer.collected).toHaveLength(0);
  });
});

describe("flow observe — supervisor", () => {
  afterEach(() => {
    clearObservers();
  });

  it("routes a supervisor's report to a flow-local observer", async () => {
    const observer = makeFakeObserver();

    const sup = supervisor({
      name: "observed-sup",
      observe: observer,
      intents: {
        a: buildScriptedAgent({
          name: "a",
          description: "does a",
          responses: [{ content: "ok", finishReason: "stop" }],
        }),
      },
      route: (ctx) => (ctx.iteration === 0 ? "a" : END),
    });

    const result = await sup.execute("seed");

    expect(result.error).toBeUndefined();
    expect(observer.collected).toHaveLength(1);
    expect(observer.collected[0]?.type).toBe("supervisor");
    expect(observer.collected[0]?.runId).toBe(result.report.runId);
  });

  it("does not route when observe is omitted (default off)", async () => {
    const observer = makeFakeObserver();

    const sup = supervisor({
      name: "unobserved-sup",
      intents: {
        a: buildScriptedAgent({
          name: "a",
          description: "does a",
          responses: [{ content: "ok", finishReason: "stop" }],
        }),
      },
      route: (ctx) => (ctx.iteration === 0 ? "a" : END),
    });

    await sup.execute("seed");

    expect(observer.collected).toHaveLength(0);
  });
});
