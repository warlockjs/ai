import type {
  EvalScore,
  EvalScorer,
  EvalScorerContext,
} from "../contracts/agent/eval.type";

/**
 * Predicate signature for {@link predicate}. Receives the same context
 * a full scorer does and returns a boolean (sync or async). A `true`
 * verdict scores `1`, `false` scores `0`.
 */
export type EvalPredicate<TOutput = unknown> = (
  context: EvalScorerContext<TOutput>,
) => boolean | Promise<boolean>;

/**
 * Normalize a value for case-insensitive, whitespace-trimmed string
 * comparison. Non-string values are JSON-serialized first so a
 * structured `expected` can still be matched against structured
 * `output`.
 */
function normalizeForComparison(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.trim().toLowerCase();
}

/**
 * Exact-match scorer. Compares the agent's output against the case's
 * `expected` reference. Prefers `result.data` (parsed structured
 * output) when present, falling back to `result.text`. Comparison is
 * trimmed and case-insensitive; structured values are compared by
 * canonical JSON.
 *
 * Scores `1` / `passed: true` on a match, `0` / `passed: false`
 * otherwise. A case with no `expected` always scores `0` — exact
 * matching is meaningless without a reference.
 *
 * @example
 * const report = await agent.eval({
 *   cases: [{ name: "q", input: "2+2?", expected: "4" }],
 *   scorers: [exact()],
 * });
 */
export function exact<TOutput = unknown>(): EvalScorer<TOutput> {
  return (context: EvalScorerContext<TOutput>): EvalScore => {
    if (context.case.expected === undefined) {
      return {
        score: 0,
        passed: false,
        reason: "no expected value supplied for exact match",
      };
    }

    const actual = context.output ?? context.text;

    if (actual === undefined) {
      return { score: 0, passed: false, reason: "agent produced no output" };
    }

    const matches =
      normalizeForComparison(actual) === normalizeForComparison(context.case.expected);

    return {
      score: matches ? 1 : 0,
      passed: matches,
      reason: matches ? "exact match" : "output did not match expected",
    };
  };
}

/**
 * Substring / contains scorer. Passes when the normalized `expected`
 * string appears anywhere in the agent's normalized output. Useful
 * when the agent's phrasing varies but a key fact must be present.
 *
 * @example
 * scorers: [contains()] // expected "Cairo" passes "The capital is Cairo."
 */
export function contains<TOutput = unknown>(): EvalScorer<TOutput> {
  return (context: EvalScorerContext<TOutput>): EvalScore => {
    if (context.case.expected === undefined) {
      return {
        score: 0,
        passed: false,
        reason: "no expected value supplied for contains match",
      };
    }

    const actual = context.output ?? context.text;

    if (actual === undefined) {
      return { score: 0, passed: false, reason: "agent produced no output" };
    }

    const found = normalizeForComparison(actual).includes(
      normalizeForComparison(context.case.expected),
    );

    return {
      score: found ? 1 : 0,
      passed: found,
      reason: found ? "expected substring found" : "expected substring not found",
    };
  };
}

/**
 * Predicate scorer. Wraps a boolean-returning callback into a scorer —
 * `true` scores `1` / `passed`, `false` scores `0` / fails. The
 * escape hatch for arbitrary assertions ("output is valid JSON", "no
 * tool errored", "duration under budget") that don't fit exact or
 * judge scoring.
 *
 * @example
 * scorers: [predicate((ctx) => ctx.result.report.children.every(c => c.status === "completed"))]
 */
export function predicate<TOutput = unknown>(
  fn: EvalPredicate<TOutput>,
): EvalScorer<TOutput> {
  return async (context: EvalScorerContext<TOutput>): Promise<EvalScore> => {
    const result = await fn(context);

    return {
      score: result ? 1 : 0,
      passed: result,
      reason: result ? "predicate passed" : "predicate failed",
    };
  };
}
