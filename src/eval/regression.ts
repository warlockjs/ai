import type { EvalRegression, EvalReport } from "../contracts/agent/eval.type";

/**
 * Diff a fresh {@link EvalReport} against a `baseline`, joining cases by
 * name, to produce an {@link EvalRegression} verdict.
 *
 * A case **regresses** when its new aggregate `score` is more than
 * `tolerance` below its baseline score (`before - after > tolerance`).
 * Cases that improved, held steady, or moved within `tolerance` are not
 * flagged. Cases present in only one of the two reports are surfaced
 * under `added` / `removed` rather than treated as regressions, so adding
 * or dropping a case never fails the gate by itself.
 *
 * Pure — depends only on the two reports and the tolerance; attaches no
 * state and mutates neither input.
 *
 * @param report - The newly produced report.
 * @param baseline - A prior report to compare against.
 * @param tolerance - Max allowed score drop before a case counts as a
 *   regression. Defaults to `0` (any drop regresses).
 *
 * @example
 * const regression = diff(report, baseline, 0.05);
 * expect(regression.passed).toBe(true);
 */
export function diff<TOutput = unknown>(
  report: EvalReport<TOutput>,
  baseline: EvalReport<TOutput>,
  tolerance = 0,
): EvalRegression {
  const baselineScores = new Map<string, number>();

  for (const entry of baseline.cases) {
    baselineScores.set(entry.case.name, entry.score);
  }

  const currentNames = new Set<string>();
  const regressed: EvalRegression["regressed"] = [];

  for (const entry of report.cases) {
    const name = entry.case.name;
    currentNames.add(name);

    const before = baselineScores.get(name);

    if (before === undefined) {
      continue;
    }

    if (before - entry.score > tolerance) {
      regressed.push({ name, before, after: entry.score });
    }
  }

  const removed = baseline.cases
    .map((entry) => entry.case.name)
    .filter((name) => !currentNames.has(name));

  const added = report.cases
    .map((entry) => entry.case.name)
    .filter((name) => !baselineScores.has(name));

  return {
    regressed,
    removed,
    added,
    passed: regressed.length === 0,
  };
}
