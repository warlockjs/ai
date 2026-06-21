import { describe, expect, it, vi } from "vitest";
import { mockAgent } from "../mock/mock-agent";
import { contains, exact, predicate } from "./scorers";
import { judge } from "./judge-scorer";

describe("agent.eval", () => {
  it("should pass a case when the exact scorer matches", async () => {
    const subject = mockAgent({
      name: "geo",
      responses: [{ content: "Cairo", finishReason: "stop" }],
    });

    const report = await subject.eval({
      cases: [{ name: "capital", input: "Capital of Egypt?", expected: "Cairo" }],
      scorers: [exact()],
    });

    expect(report.passed).toBe(true);
    expect(report.passedCount).toBe(1);
    expect(report.failedCount).toBe(0);
    expect(report.passRate).toBe(1);
    expect(report.cases[0].score).toBe(1);
  });

  it("should fail a case when the exact scorer does not match", async () => {
    const subject = mockAgent({
      name: "geo",
      responses: [{ content: "Alexandria", finishReason: "stop" }],
    });

    const report = await subject.eval({
      cases: [{ name: "capital", input: "Capital of Egypt?", expected: "Cairo" }],
      scorers: [exact()],
    });

    expect(report.passed).toBe(false);
    expect(report.failedCount).toBe(1);
    expect(report.cases[0].passed).toBe(false);
  });

  it("should normalize case and whitespace for exact matching", async () => {
    const subject = mockAgent({
      name: "geo",
      responses: [{ content: "  CAIRO  ", finishReason: "stop" }],
    });

    const report = await subject.eval({
      cases: [{ name: "capital", input: "?", expected: "cairo" }],
      scorers: [exact()],
    });

    expect(report.passed).toBe(true);
  });

  it("should pass a contains scorer on a substring", async () => {
    const subject = mockAgent({
      name: "geo",
      responses: [{ content: "The capital is Cairo, a large city.", finishReason: "stop" }],
    });

    const report = await subject.eval({
      cases: [{ name: "capital", input: "?", expected: "Cairo" }],
      scorers: [contains()],
    });

    expect(report.passed).toBe(true);
  });

  it("should support predicate scorers over the result", async () => {
    const subject = mockAgent({
      name: "writer",
      responses: [{ content: "hello world", finishReason: "stop" }],
    });

    const report = await subject.eval({
      cases: [{ name: "len", input: "say hi" }],
      scorers: [predicate((ctx) => (ctx.text ?? "").length > 5)],
    });

    expect(report.passed).toBe(true);
  });

  it("should AND multiple scorers — one failing fails the case", async () => {
    const subject = mockAgent({
      name: "writer",
      responses: [{ content: "Cairo", finishReason: "stop" }],
    });

    const report = await subject.eval({
      cases: [{ name: "c", input: "?", expected: "Cairo" }],
      scorers: [exact(), predicate(() => false)],
    });

    expect(report.passed).toBe(false);
    expect(report.cases[0].scores).toHaveLength(2);
  });

  it("should average scores into a mean across the suite", async () => {
    const subject = mockAgent({
      name: "writer",
      responses: [
        { content: "Cairo", finishReason: "stop" },
        { content: "wrong", finishReason: "stop" },
      ],
    });

    const report = await subject.eval({
      cases: [
        { name: "ok", input: "?", expected: "Cairo" },
        { name: "bad", input: "?", expected: "Cairo" },
      ],
      scorers: [exact()],
    });

    expect(report.total).toBe(2);
    expect(report.passedCount).toBe(1);
    expect(report.meanScore).toBe(0.5);
    expect(report.passRate).toBe(0.5);
  });

  it("should fire onFailure for each failed case", async () => {
    const subject = mockAgent({
      name: "writer",
      responses: [{ content: "nope", finishReason: "stop" }],
    });

    const onFailure = vi.fn();

    await subject.eval({
      cases: [{ name: "bad", input: "?", expected: "Cairo" }],
      scorers: [exact()],
      onFailure,
    });

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0][0].case.name).toBe("bad");
  });

  it("should not fire onFailure for passing cases", async () => {
    const subject = mockAgent({
      name: "writer",
      responses: [{ content: "Cairo", finishReason: "stop" }],
    });

    const onFailure = vi.fn();

    await subject.eval({
      cases: [{ name: "ok", input: "?", expected: "Cairo" }],
      scorers: [exact()],
      onFailure,
    });

    expect(onFailure).not.toHaveBeenCalled();
  });

  it("should swallow a throwing onFailure handler", async () => {
    const subject = mockAgent({
      name: "writer",
      responses: [{ content: "nope", finishReason: "stop" }],
    });

    const report = await subject.eval({
      cases: [{ name: "bad", input: "?", expected: "Cairo" }],
      scorers: [exact()],
      onFailure: () => {
        throw new Error("reporting bug");
      },
    });

    expect(report.failedCount).toBe(1);
  });

  it("should let a per-case scorer override the suite scorers", async () => {
    const subject = mockAgent({
      name: "writer",
      responses: [{ content: "anything", finishReason: "stop" }],
    });

    const report = await subject.eval({
      cases: [
        { name: "always", input: "?", scorers: [predicate(() => true)] },
      ],
      scorers: [exact()],
    });

    expect(report.passed).toBe(true);
  });

  it("should throw at author time when a case has no scorer", async () => {
    const subject = mockAgent({ name: "writer" });

    await expect(
      subject.eval({ cases: [{ name: "orphan", input: "?" }] }),
    ).rejects.toThrow(/no scorer/);
  });

  it("should fail a case when the agent itself errors", async () => {
    const subject = mockAgent({
      name: "boom",
      responses: [{ content: "", error: new Error("provider down") }],
    });

    const report = await subject.eval({
      cases: [{ name: "err", input: "?" }],
      scorers: [predicate(() => true)],
    });

    expect(report.passed).toBe(false);
    expect(report.cases[0].result.error).toBeDefined();
  });

  it("should derive pass from passThreshold when scorer omits passed", async () => {
    const subject = mockAgent({
      name: "writer",
      responses: [{ content: "x", finishReason: "stop" }],
    });

    const report = await subject.eval({
      cases: [{ name: "c", input: "?" }],
      scorers: [() => ({ score: 0.4 })],
      passThreshold: 0.5,
    });

    expect(report.passed).toBe(false);
    expect(report.cases[0].score).toBe(0.4);
  });
});

describe("ai.eval.judge (LLM-as-judge)", () => {
  it("should score via the judge agent's parsed verdict", async () => {
    const subject = mockAgent({
      name: "writer",
      responses: [{ content: "an empathetic reply", finishReason: "stop" }],
    });

    const judgeAgent = mockAgent({
      name: "judge",
      responses: [
        { content: '{ "score": 1, "passed": true, "reason": "warm tone" }', finishReason: "stop" },
      ],
    });

    const report = await subject.eval({
      cases: [{ name: "tone", input: "comfort the user" }],
      judge: { agent: judgeAgent, rubric: "Score 1 only if empathetic." },
    });

    expect(report.passed).toBe(true);
    expect(report.cases[0].scores[0].reason).toBe("warm tone");
  });

  it("should fail when the judge verdict scores below threshold", async () => {
    const subject = mockAgent({
      name: "writer",
      responses: [{ content: "rude reply", finishReason: "stop" }],
    });

    const judgeAgent = mockAgent({
      name: "judge",
      responses: [{ content: '{ "score": 0.1 }', finishReason: "stop" }],
    });

    const report = await subject.eval({
      cases: [{ name: "tone", input: "comfort the user" }],
      judge: { agent: judgeAgent },
      passThreshold: 0.5,
    });

    expect(report.passed).toBe(false);
  });

  it("should fail the case when the judge returns unparseable text", async () => {
    const subject = mockAgent({
      name: "writer",
      responses: [{ content: "reply", finishReason: "stop" }],
    });

    const judgeAgent = mockAgent({
      name: "judge",
      responses: [{ content: "not json at all", finishReason: "stop" }],
    });

    const report = await subject.eval({
      cases: [{ name: "tone", input: "?" }],
      judge: { agent: judgeAgent },
    });

    expect(report.passed).toBe(false);
    expect(report.cases[0].scores[0].reason).toMatch(/parseable/);
  });

  it("should use judge() scorer directly with a fenced JSON verdict", async () => {
    const subject = mockAgent({
      name: "writer",
      responses: [{ content: "answer", finishReason: "stop" }],
    });

    const judgeAgent = mockAgent({
      name: "judge",
      responses: [
        { content: '```json\n{ "score": 0.9, "passed": true }\n```', finishReason: "stop" },
      ],
    });

    const scorer = judge({ agent: judgeAgent });
    const result = await subject.execute("hi");

    const score = await scorer({ case: { name: "x", input: "hi" }, result, text: result.text });

    expect(score.passed).toBe(true);
    expect(score.score).toBe(0.9);
  });
});
