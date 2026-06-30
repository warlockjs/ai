import { describe, expect, it } from "vitest";
import type { EvalCaseResult, EvalReport } from "../contracts/agent/eval.type";
import { diff } from "./regression";

/** Build a minimal case result carrying only the fields `diff` reads. */
function caseResult(name: string, score: number): EvalCaseResult {
  return {
    case: { name, input: name },
    result: { text: "", report: { children: [] } } as unknown as EvalCaseResult["result"],
    scores: [],
    score,
    passed: score >= 0.5,
    duration: 0,
  };
}

/** Build a minimal report from `name → score` pairs. */
function report(scores: Record<string, number>): EvalReport {
  const cases = Object.entries(scores).map(([name, score]) => caseResult(name, score));

  return {
    agentName: "subject",
    total: cases.length,
    passedCount: cases.filter((entry) => entry.passed).length,
    failedCount: cases.filter((entry) => !entry.passed).length,
    passRate: 0,
    meanScore: 0,
    passed: true,
    cases,
    duration: 0,
  };
}

describe("diff", () => {
  it("should pass when no case regressed", () => {
    const baseline = report({ a: 1, b: 0.8 });
    const current = report({ a: 1, b: 0.9 });

    const regression = diff(current, baseline);

    expect(regression.passed).toBe(true);
    expect(regression.regressed).toEqual([]);
    expect(regression.added).toEqual([]);
    expect(regression.removed).toEqual([]);
  });

  it("should flag a case whose score dropped beyond tolerance", () => {
    const baseline = report({ a: 1, b: 0.9 });
    const current = report({ a: 1, b: 0.5 });

    const regression = diff(current, baseline);

    expect(regression.passed).toBe(false);
    expect(regression.regressed).toEqual([{ name: "b", before: 0.9, after: 0.5 }]);
  });

  it("should not flag a drop within tolerance", () => {
    const baseline = report({ a: 1 });
    const current = report({ a: 0.95 });

    const regression = diff(current, baseline, 0.1);

    expect(regression.passed).toBe(true);
    expect(regression.regressed).toEqual([]);
  });

  it("should treat a drop exactly equal to tolerance as passing", () => {
    const baseline = report({ a: 1 });
    const current = report({ a: 0.9 });

    // before - after === tolerance is NOT a regression (strictly greater).
    const regression = diff(current, baseline, 0.1);

    expect(regression.passed).toBe(true);
  });

  it("should report added and removed cases without counting them as regressions", () => {
    const baseline = report({ a: 1, gone: 1 });
    const current = report({ a: 1, fresh: 1 });

    const regression = diff(current, baseline);

    expect(regression.added).toEqual(["fresh"]);
    expect(regression.removed).toEqual(["gone"]);
    expect(regression.regressed).toEqual([]);
    expect(regression.passed).toBe(true);
  });

  it("should not flag improvements", () => {
    const baseline = report({ a: 0.4 });
    const current = report({ a: 0.9 });

    const regression = diff(current, baseline);

    expect(regression.passed).toBe(true);
    expect(regression.regressed).toEqual([]);
  });
});
