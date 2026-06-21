import type { AgentContract } from "./agent.contract";
import type { AgentExecuteOptions } from "./agent-options.type";
import type { AgentResult } from "../result/agent-result.type";

/**
 * Outcome the scorer assigns to a single case. `score` is a normalized
 * `0..1` quality signal; `passed` is the boolean gate the suite asserts
 * on. A scorer may set `passed` independently of `score` (e.g. a hard
 * threshold) — when it returns only a `score`, the runner derives
 * `passed` from `score >= passThreshold`.
 */
export type EvalScore = {
  /** Normalized quality signal in `[0, 1]`. */
  score: number;
  /**
   * Whether this case counts as a pass. When omitted the runner
   * derives it from `score >= passThreshold`.
   */
  passed?: boolean;
  /** Optional human-readable explanation surfaced in the report. */
  reason?: string;
};

/**
 * Context handed to a {@link EvalScorer} for one case. Carries the
 * case definition, the agent's actual result, and the parsed output /
 * raw text shortcuts so a scorer never has to re-narrow the result
 * union.
 */
export type EvalScorerContext<TOutput = unknown> = {
  /** The case currently being scored. */
  case: EvalCase<TOutput>;
  /** The full `AgentResult` produced by running the case input. */
  result: AgentResult<TOutput>;
  /** Shortcut for `result.data` — the parsed structured output, if any. */
  output?: TOutput;
  /** Shortcut for `result.text` — the raw final-trip text. */
  text?: string;
};

/**
 * Scorer for a single eval case. Returns an {@link EvalScore} (sync or
 * async). Three built-in scorers ship via the `ai.eval` namespace:
 * `exactScorer`, `predicateScorer`, and `judgeScorer` (LLM-as-judge).
 * Custom scorers implement this signature directly.
 */
export type EvalScorer<TOutput = unknown> = (
  context: EvalScorerContext<TOutput>,
) => EvalScore | Promise<EvalScore>;

/**
 * A single evaluation case. `input` is the prompt fed to the agent;
 * `expected` is the optional reference answer exact / judge scorers
 * compare against. `scorers` overrides the suite-level scorer list for
 * this case only; `options` overrides the per-call execute options.
 */
export type EvalCase<TOutput = unknown> = {
  /** Stable identifier for the case — surfaced in the report. */
  name: string;
  /** Prompt fed to `agent.execute(input)`. */
  input: string;
  /**
   * Reference answer the default scorers compare against. Free-form —
   * a string for text comparison, a structured value for output
   * comparison, or omitted when the scorer is purely predicate-based.
   */
  expected?: unknown;
  /** Per-case scorer override. Falls back to the suite `scorers`. */
  scorers?: EvalScorer<TOutput>[];
  /** Per-case execute-options override merged over the suite default. */
  options?: AgentExecuteOptions<TOutput>;
};

/**
 * LLM-as-judge configuration. When supplied to `agent.eval`, the
 * judge agent scores every case that has no explicit `scorers`. The
 * judge receives the case input, the expected reference (if any), and
 * the actual output, and returns a `{ score, passed?, reason? }`
 * verdict.
 *
 * `agent` must be name-bearing and configured with an output schema
 * matching the judge verdict shape — the runner extracts `score` /
 * `passed` / `reason` from `result.data`, falling back to parsing the
 * raw text when no schema is set.
 */
export type EvalJudge = {
  /** The judge agent. Runs once per case scored by the judge. */
  agent: AgentContract<unknown>;
  /**
   * Optional rubric prepended to the judge prompt — the criteria the
   * judge grades against ("score 1.0 only if the answer cites a
   * source", etc.).
   */
  rubric?: string;
  /**
   * Score at or above which the judge verdict counts as a pass when
   * the judge returns only a numeric score. Defaults to the suite
   * `passThreshold`.
   */
  passThreshold?: number;
};

/**
 * Options for `agent.eval`.
 *
 * `cases` is the suite; `scorers` is the default scorer list applied
 * to every case lacking its own; `judge` enables LLM-as-judge scoring
 * for cases with neither. At least one of `scorers` / `judge` must be
 * resolvable per case or the runner throws at author time.
 */
export type EvalOptions<TOutput = unknown> = {
  /** The evaluation cases to run. */
  cases: EvalCase<TOutput>[];
  /** Default scorers applied to every case without its own `scorers`. */
  scorers?: EvalScorer<TOutput>[];
  /** LLM-as-judge fallback for cases with no scorers. */
  judge?: EvalJudge;
  /**
   * Score at or above which a case passes when a scorer returns only a
   * numeric `score` (no explicit `passed`). Defaults to `0.5`.
   */
  passThreshold?: number;
  /**
   * Fired once per failing case, after it is scored. Receives the
   * full case result so suites can log, snapshot, or accumulate
   * failures. Errors thrown here are swallowed so a reporting bug
   * cannot abort the run.
   */
  onFailure?: (caseResult: EvalCaseResult<TOutput>) => void | Promise<void>;
  /** Execute-options applied to every case (merged under per-case `options`). */
  executeOptions?: AgentExecuteOptions<TOutput>;
};

/**
 * Per-case outcome in an {@link EvalReport}. Bundles the case, the
 * agent result, the resolved scores, and the case-level pass/fail
 * verdict (the AND of every scorer's `passed`).
 */
export type EvalCaseResult<TOutput = unknown> = {
  /** The case that produced this result. */
  case: EvalCase<TOutput>;
  /** The full agent result for the case input. */
  result: AgentResult<TOutput>;
  /** Every scorer's verdict, in scorer order. */
  scores: EvalScore[];
  /** Mean of `scores[].score` — the case's aggregate quality signal. */
  score: number;
  /** `true` only when EVERY scorer passed and the agent did not error. */
  passed: boolean;
  /** Wall-clock duration of the case run in milliseconds. */
  duration: number;
};

/**
 * Aggregate report returned by `agent.eval`. Summarizes pass rate and
 * mean score across the suite and carries every per-case result for
 * drill-down. Assertion-friendly: `expect(report.passed).toBe(true)`.
 */
export type EvalReport<TOutput = unknown> = {
  /** Name of the agent under evaluation. */
  agentName: string;
  /** Total number of cases run. */
  total: number;
  /** Number of cases that passed. */
  passedCount: number;
  /** Number of cases that failed. */
  failedCount: number;
  /** `passedCount / total` in `[0, 1]`. */
  passRate: number;
  /** Mean of every case's aggregate `score`. */
  meanScore: number;
  /** `true` only when every case passed. */
  passed: boolean;
  /** Per-case results in suite order. */
  cases: EvalCaseResult<TOutput>[];
  /** Total wall-clock duration of the whole suite in milliseconds. */
  duration: number;
};
