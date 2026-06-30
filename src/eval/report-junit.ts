import type { EvalCaseResult, EvalReport } from "../contracts/agent/eval.type";

/**
 * Escape the five XML predefined entities so arbitrary text (case names,
 * failure reasons, agent names) is safe inside an attribute value or
 * element body. Covers `&`, `<`, `>`, `"`, and `'`.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build the `<failure>` body for a failed case: the joined reasons of
 * every non-passing scorer, falling back to a generic message when a
 * scorer offered no reason (or the failure was an agent error).
 */
function failureMessage(entry: EvalCaseResult): string {
  if (entry.result.error) {
    return `agent error: ${entry.result.error.message}`;
  }

  const reasons = entry.scores
    .filter((score) => score.passed === false)
    .map((score) => score.reason)
    .filter((reason): reason is string => typeof reason === "string" && reason !== "");

  if (reasons.length > 0) {
    return reasons.join("; ");
  }

  return "case did not pass";
}

/**
 * Serialize an {@link EvalReport} to a JUnit-XML string for CI ingestion.
 *
 * **Role.** A pure, runner-decoupled reporter: one `<testsuite>` whose
 * name is the agent, one `<testcase>` per eval case, a `<failure>` child
 * on each case that did not pass (with the joined scorer reasons), and a
 * `time` attribute carrying the case / suite duration in **seconds**
 * (JUnit's unit; the report stores milliseconds).
 *
 * XML is hand-emitted (no `xml` dependency) and every dynamic value is
 * entity-escaped via {@link escapeXml}.
 *
 * @example
 * await writeFile("./report.junit.xml", toJUnit(report));
 */
export function toJUnit(report: EvalReport): string {
  const suiteName = escapeXml(report.agentName);
  const suiteTime = (report.duration / 1000).toFixed(3);

  const lines: string[] = [];

  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<testsuite name="${suiteName}" tests="${report.total}" failures="${report.failedCount}" time="${suiteTime}">`,
  );

  for (const entry of report.cases) {
    const caseName = escapeXml(entry.case.name);
    const caseTime = (entry.duration / 1000).toFixed(3);

    if (entry.passed) {
      lines.push(
        `  <testcase name="${caseName}" classname="${suiteName}" time="${caseTime}"/>`,
      );

      continue;
    }

    const message = failureMessage(entry);
    lines.push(
      `  <testcase name="${caseName}" classname="${suiteName}" time="${caseTime}">`,
    );
    lines.push(
      `    <failure message="${escapeXml(message)}">${escapeXml(message)}</failure>`,
    );
    lines.push("  </testcase>");
  }

  lines.push("</testsuite>");

  return lines.join("\n");
}
