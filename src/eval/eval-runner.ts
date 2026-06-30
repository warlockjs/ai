import type { AgentContract } from "../contracts/agent/agent.contract";
import type { AgentExecuteOptions } from "../contracts/agent/agent-options.type";
import type {
  EvalCase,
  EvalCaseResult,
  EvalOptions,
  EvalReport,
  EvalScore,
  EvalScorer,
  EvalScorerContext,
} from "../contracts/agent/eval.type";
import type { EvalCase as EvalCaseType } from "../contracts/agent/eval.type";
import { AgentExecutionError } from "../errors";
import { log } from "@warlock.js/logger";
import { judge as judgeScorer } from "./judge-scorer";
import { diff } from "./regression";

/**
 * Narrow `EvalOptions.cases` to the underlying `EvalCase[]`. A
 * `DatasetContract` is identified structurally by its `cases` property
 * (an array carried alongside `name` / `filter` / `shard`); a raw
 * `EvalCase[]` is used as-is.
 */
function resolveCases<TOutput>(
  cases: EvalOptions<TOutput>["cases"],
): EvalCaseType<TOutput>[] {
  if (Array.isArray(cases)) {
    return cases;
  }

  return cases.cases;
}

const LOG_MODULE = "ai.eval";
const DEFAULT_PASS_THRESHOLD = 0.5;

/**
 * Resolve the scorer list for a single case. Precedence: the case's
 * own `scorers` → the suite `scorers` → a synthesized judge scorer
 * when `judge` is configured. Throws an authoring-time
 * `AgentExecutionError` when a case can resolve none — an eval suite
 * with no way to score a case is a config bug worth surfacing at the
 * call site, not a silent pass.
 */
function resolveScorers<TOutput>(
  evalCase: EvalCase<TOutput>,
  options: EvalOptions<TOutput>,
  passThreshold: number,
): EvalScorer<TOutput>[] {
  if (evalCase.scorers && evalCase.scorers.length > 0) {
    return evalCase.scorers;
  }

  if (options.scorers && options.scorers.length > 0) {
    return options.scorers;
  }

  if (options.judge) {
    return [judgeScorer<TOutput>(options.judge, passThreshold)];
  }

  throw new AgentExecutionError(
    `eval case "${evalCase.name}" has no scorer — supply per-case "scorers", suite "scorers", or a "judge"`,
    { context: { authoring: true, case: evalCase.name } },
  );
}

/**
 * Decide a single scorer verdict's pass/fail. Honors an explicit
 * `passed` from the scorer; otherwise derives it from
 * `score >= passThreshold`.
 */
function isScorePassing(score: EvalScore, passThreshold: number): boolean {
  if (typeof score.passed === "boolean") {
    return score.passed;
  }

  return score.score >= passThreshold;
}

/**
 * Merge suite-level execute options with the case's own override.
 * Per-case wins on conflict (shallow merge).
 */
function mergeOptions<TOutput>(
  suite: AgentExecuteOptions<TOutput> | undefined,
  perCase: AgentExecuteOptions<TOutput> | undefined,
): AgentExecuteOptions<TOutput> | undefined {
  if (!suite) return perCase;
  if (!perCase) return suite;
  return { ...suite, ...perCase };
}

/**
 * Run one case end-to-end: execute the agent, run every resolved
 * scorer, aggregate into an {@link EvalCaseResult}. A case passes only
 * when the agent did not error AND every scorer passed.
 */
async function runCase<TOutput>(
  agent: AgentContract<TOutput>,
  evalCase: EvalCase<TOutput>,
  options: EvalOptions<TOutput>,
  passThreshold: number,
): Promise<EvalCaseResult<TOutput>> {
  const scorers = resolveScorers(evalCase, options, passThreshold);
  const executeOptions = mergeOptions(options.executeOptions, evalCase.options);

  const start = performance.now();
  const result = await agent.execute(evalCase.input, executeOptions);
  const duration = performance.now() - start;

  const context: EvalScorerContext<TOutput> = {
    case: evalCase,
    result,
    output: result.data,
    text: result.text,
  };

  const scores: EvalScore[] = [];

  for (const scorer of scorers) {
    scores.push(await scorer(context));
  }

  const meanScore =
    scores.length > 0 ? scores.reduce((sum, score) => sum + score.score, 0) / scores.length : 0;

  const allScorersPassed = scores.every((score) => isScorePassing(score, passThreshold));
  const passed = result.error === undefined && allScorersPassed;

  return {
    case: evalCase,
    result,
    scores,
    score: meanScore,
    passed,
    duration,
  };
}

/**
 * Core implementation of `agent.eval`. Runs every case sequentially
 * (cases share the agent and may carry side effects — ordering must be
 * deterministic), scores each, fires `onFailure` for failed cases, and
 * assembles the aggregate {@link EvalReport}.
 *
 * Never throws on a case-level failure; the only throw is the
 * authoring-time "no scorer" guard from {@link resolveScorers}.
 */
export async function runEval<TOutput>(
  agent: AgentContract<TOutput>,
  options: EvalOptions<TOutput>,
): Promise<EvalReport<TOutput>> {
  const passThreshold = options.passThreshold ?? DEFAULT_PASS_THRESHOLD;
  const start = performance.now();

  const suiteCases = resolveCases(options.cases);
  const cases: EvalCaseResult<TOutput>[] = [];

  for (const evalCase of suiteCases) {
    const caseResult = await runCase(agent, evalCase, options, passThreshold);

    cases.push(caseResult);

    if (!caseResult.passed && options.onFailure) {
      try {
        await options.onFailure(caseResult);
      } catch (error) {
        log.warn(LOG_MODULE, "onFailure.hook.error", "eval onFailure handler threw", {
          agent: agent.name,
          case: evalCase.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const passedCount = cases.filter((entry) => entry.passed).length;
  const total = cases.length;
  const meanScore =
    total > 0 ? cases.reduce((sum, entry) => sum + entry.score, 0) / total : 0;

  const report: EvalReport<TOutput> = {
    agentName: agent.name,
    total,
    passedCount,
    failedCount: total - passedCount,
    passRate: total > 0 ? passedCount / total : 0,
    meanScore,
    passed: total > 0 && passedCount === total,
    cases,
    duration: performance.now() - start,
  };

  if (options.baseline) {
    report.regression = diff(report, options.baseline, options.tolerance);
  }

  return report;
}
