import { describe, expect, it } from "vitest";
import type { EvalCaseResult, EvalReport } from "../contracts/agent/eval.type";
import { fromJSON, toJSON } from "./report-json";
import { toJUnit } from "./report-junit";

/** Build a case result with a controllable pass/fail + scorer reason. */
function caseResult(
  name: string,
  options: { passed: boolean; reason?: string; error?: string; duration?: number } = {
    passed: true,
  },
): EvalCaseResult {
  return {
    case: { name, input: name },
    result: {
      text: "",
      error: options.error ? { message: options.error } : undefined,
      report: { children: [] },
    } as unknown as EvalCaseResult["result"],
    scores: options.passed
      ? [{ score: 1, passed: true }]
      : [{ score: 0, passed: false, reason: options.reason }],
    score: options.passed ? 1 : 0,
    passed: options.passed,
    duration: options.duration ?? 0,
  };
}

function report(cases: EvalCaseResult[], agentName = "subject"): EvalReport {
  const passedCount = cases.filter((entry) => entry.passed).length;

  return {
    agentName,
    total: cases.length,
    passedCount,
    failedCount: cases.length - passedCount,
    passRate: cases.length > 0 ? passedCount / cases.length : 0,
    meanScore: 0,
    passed: passedCount === cases.length,
    cases,
    duration: 1500,
  };
}

describe("toJUnit", () => {
  it("should emit a testsuite with per-case testcases", () => {
    const xml = toJUnit(
      report([
        caseResult("a", { passed: true, duration: 100 }),
        caseResult("b", { passed: false, reason: "output did not match" }),
      ]),
    );

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain(
      '<testsuite name="subject" tests="2" failures="1" time="1.500">',
    );
    expect(xml).toContain('<testcase name="a" classname="subject" time="0.100"/>');
    expect(xml).toContain('<failure message="output did not match">output did not match</failure>');
    expect(xml).toContain("</testsuite>");
  });

  it("should surface an agent error in the failure body", () => {
    const xml = toJUnit(report([caseResult("boom", { passed: false, error: "timeout" })]));

    expect(xml).toContain("agent error: timeout");
  });

  it("should escape XML-significant characters in names and reasons", () => {
    const xml = toJUnit(
      report(
        [caseResult('a & <b>', { passed: false, reason: 'reason "x" < y' })],
        "agent <one>",
      ),
    );

    expect(xml).toContain("a &amp; &lt;b&gt;");
    expect(xml).toContain("agent &lt;one&gt;");
    expect(xml).toContain("reason &quot;x&quot; &lt; y");
    expect(xml).not.toContain("<b>");
  });

  it("should fall back to a generic message when a failing scorer gave no reason", () => {
    const xml = toJUnit(report([caseResult("c", { passed: false })]));

    expect(xml).toContain("case did not pass");
  });
});

describe("toJSON / fromJSON", () => {
  it("should round-trip a report's data", () => {
    const original = report([
      caseResult("a", { passed: true }),
      caseResult("b", { passed: false, reason: "nope" }),
    ]);

    const restored = fromJSON(toJSON(original));

    expect(restored.agentName).toBe("subject");
    expect(restored.total).toBe(2);
    expect(restored.cases.map((entry) => entry.case.name)).toEqual(["a", "b"]);
    expect(restored.cases[1].scores[0].reason).toBe("nope");
  });

  it("should preserve an attached regression block through the round-trip", () => {
    const base = report([caseResult("a", { passed: true })]);
    base.regression = {
      regressed: [{ name: "a", before: 1, after: 0.2 }],
      removed: [],
      added: [],
      passed: false,
    };

    const restored = fromJSON(toJSON(base));

    expect(restored.regression?.passed).toBe(false);
    expect(restored.regression?.regressed[0]).toEqual({ name: "a", before: 1, after: 0.2 });
  });

  it("should produce pretty-printed JSON", () => {
    const json = toJSON(report([caseResult("a", { passed: true })]));

    expect(json).toContain("\n  ");
  });
});
