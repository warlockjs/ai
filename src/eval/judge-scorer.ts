import type {
  EvalJudge,
  EvalScore,
  EvalScorer,
  EvalScorerContext,
} from "../contracts/agent/eval.type";
import { extractJsonPayload, safeJsonParse } from "../utils";

/**
 * Raw shape the judge agent is expected to return — either parsed from
 * `result.data` (when the judge has an output schema) or extracted
 * from `result.text`.
 */
type JudgeVerdict = {
  score?: unknown;
  passed?: unknown;
  reason?: unknown;
};

/** Clamp an arbitrary numeric value into the `[0, 1]` score range. */
function clampScore(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Render the prompt the judge agent receives for one case. Includes
 * the rubric (if any), the original question, the expected reference
 * (when supplied), and the actual answer — then asks for a strict JSON
 * verdict so the response is machine-parseable even without an output
 * schema.
 */
function buildJudgePrompt(context: EvalScorerContext, judge: EvalJudge): string {
  const lines: string[] = [];

  if (judge.rubric) {
    lines.push(`Grading rubric:\n${judge.rubric}`, "");
  }

  lines.push(`Question:\n${context.case.input}`, "");

  if (context.case.expected !== undefined) {
    const expectedText =
      typeof context.case.expected === "string"
        ? context.case.expected
        : JSON.stringify(context.case.expected);
    lines.push(`Reference answer:\n${expectedText}`, "");
  }

  const actual = context.text ?? JSON.stringify(context.output ?? null);
  lines.push(`Answer to grade:\n${actual}`, "");

  lines.push(
    'Respond with JSON only: { "score": <0..1>, "passed": <true|false>, "reason": "<short explanation>" }.',
  );

  return lines.join("\n");
}

/**
 * Coerce the judge agent's parsed/extracted verdict into a normalized
 * {@link EvalScore}. Defends against a judge that returns a string
 * score or omits `passed` — the caller-supplied `passThreshold`
 * derives `passed` from `score` when the judge didn't decide.
 */
function toEvalScore(verdict: JudgeVerdict, passThreshold: number): EvalScore {
  const rawScore = typeof verdict.score === "string" ? Number(verdict.score) : verdict.score;
  const score = clampScore(typeof rawScore === "number" ? rawScore : 0);

  const passed = typeof verdict.passed === "boolean" ? verdict.passed : score >= passThreshold;

  const reason = typeof verdict.reason === "string" ? verdict.reason : undefined;

  return { score, passed, reason };
}

/**
 * LLM-as-judge scorer. Runs the judge agent on a prompt built from the
 * case (question + expected + actual answer + rubric) and parses its
 * `{ score, passed?, reason? }` verdict.
 *
 * Verdict source order: `result.data` (when the judge declares an
 * output schema), then `result.text` parsed as JSON. A judge that
 * errors or returns unparseable text scores `0` with the failure
 * reason attached — a broken judge fails the case rather than crashing
 * the suite.
 *
 * @example
 * scorers: [judge({ agent: judgeAgent, rubric: "Cite a source for full marks." })]
 */
export function judge<TOutput = unknown>(
  config: EvalJudge,
  passThreshold = 0.5,
): EvalScorer<TOutput> {
  const threshold = config.passThreshold ?? passThreshold;

  return async (context: EvalScorerContext<TOutput>): Promise<EvalScore> => {
    const prompt = buildJudgePrompt(context as EvalScorerContext, config);

    const verdictResult = await config.agent.execute(prompt);

    if (verdictResult.error) {
      return {
        score: 0,
        passed: false,
        reason: `judge failed: ${verdictResult.error.message}`,
      };
    }

    if (verdictResult.data && typeof verdictResult.data === "object") {
      return toEvalScore(verdictResult.data as JudgeVerdict, threshold);
    }

    const text = verdictResult.text ?? "";
    const sentinel = Symbol("judge-parse-failed");
    const parsed = safeJsonParse<unknown>(extractJsonPayload(text), sentinel);

    if (parsed === sentinel || parsed === null || typeof parsed !== "object") {
      return {
        score: 0,
        passed: false,
        reason: "judge returned no parseable verdict",
      };
    }

    return toEvalScore(parsed as JudgeVerdict, threshold);
  };
}
