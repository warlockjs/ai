import { describe, expect, it } from "vitest";
import { mockAgent } from "../mock/mock-agent";
import { dataset } from "./dataset";
import { exact } from "./scorers";

describe("agent.eval with a dataset", () => {
  it("should accept a DatasetContract in place of a raw EvalCase[]", async () => {
    const subject = mockAgent({
      name: "geo",
      responses: [
        { content: "Cairo", finishReason: "stop" },
        { content: "Paris", finishReason: "stop" },
      ],
    });

    const ds = dataset({
      name: "capitals",
      cases: [
        { name: "egypt", input: "Capital of Egypt?", expected: "Cairo" },
        { name: "france", input: "Capital of France?", expected: "Paris" },
      ],
    });

    const report = await subject.eval({ cases: ds, scorers: [exact()] });

    expect(report.total).toBe(2);
    expect(report.passed).toBe(true);
    expect(report.cases.map((entry) => entry.case.name)).toEqual(["egypt", "france"]);
  });

  it("should run a filtered/sharded dataset", async () => {
    const subject = mockAgent({
      name: "geo",
      responses: [{ content: "Cairo", finishReason: "stop" }],
    });

    const ds = dataset({
      name: "capitals",
      cases: [
        { name: "egypt", input: "?", expected: "Cairo", tags: ["smoke"] },
        { name: "france", input: "?", expected: "Paris", tags: ["slow"] },
      ],
    }).filter((entry) => entry.tags?.includes("smoke") ?? false);

    const report = await subject.eval({ cases: ds, scorers: [exact()] });

    expect(report.total).toBe(1);
    expect(report.cases[0].case.name).toBe("egypt");
  });
});

describe("agent.eval regression against a baseline", () => {
  it("should attach a passing regression block when scores held", async () => {
    const subject = mockAgent({
      name: "geo",
      responses: [{ content: "Cairo", finishReason: "stop" }],
    });

    const baseline = await subject.eval({
      cases: [{ name: "egypt", input: "?", expected: "Cairo" }],
      scorers: [exact()],
    });

    const reran = mockAgent({
      name: "geo",
      responses: [{ content: "Cairo", finishReason: "stop" }],
    });

    const report = await reran.eval({
      cases: [{ name: "egypt", input: "?", expected: "Cairo" }],
      scorers: [exact()],
      baseline,
    });

    expect(report.regression).toBeDefined();
    expect(report.regression?.passed).toBe(true);
  });

  it("should flag a regression when a previously passing case now fails", async () => {
    const good = mockAgent({
      name: "geo",
      responses: [{ content: "Cairo", finishReason: "stop" }],
    });

    const baseline = await good.eval({
      cases: [{ name: "egypt", input: "?", expected: "Cairo" }],
      scorers: [exact()],
    });

    const bad = mockAgent({
      name: "geo",
      responses: [{ content: "Alexandria", finishReason: "stop" }],
    });

    const report = await bad.eval({
      cases: [{ name: "egypt", input: "?", expected: "Cairo" }],
      scorers: [exact()],
      baseline,
    });

    expect(report.regression?.passed).toBe(false);
    expect(report.regression?.regressed).toEqual([
      { name: "egypt", before: 1, after: 0 },
    ]);
  });

  it("should not attach a regression block without a baseline", async () => {
    const subject = mockAgent({
      name: "geo",
      responses: [{ content: "Cairo", finishReason: "stop" }],
    });

    const report = await subject.eval({
      cases: [{ name: "egypt", input: "?", expected: "Cairo" }],
      scorers: [exact()],
    });

    expect(report.regression).toBeUndefined();
  });
});
