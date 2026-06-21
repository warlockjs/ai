import { judge } from "./judge-scorer";
import { contains, exact, predicate } from "./scorers";

// Runner — wired into AgentContract.eval() by the agent factory.
export { runEval } from "./eval-runner";

// Scorer factories — re-exported individually for direct import.
export { contains, exact, predicate } from "./scorers";
export type { EvalPredicate } from "./scorers";
export { judge } from "./judge-scorer";

/**
 * Built-in eval scorer factories, surfaced on `ai.eval.*`.
 *
 * - `exact()` — pass when output equals the case `expected` (trimmed,
 *   case-insensitive; structured values compared by canonical JSON).
 * - `contains()` — pass when `expected` appears as a substring.
 * - `predicate(fn)` — wrap an arbitrary boolean assertion.
 * - `judge(config)` — LLM-as-judge scoring against a rubric.
 *
 * @example
 * await myAgent.eval({
 *   cases: [{ name: "q", input: "Capital of Egypt?", expected: "Cairo" }],
 *   scorers: [ai.eval.contains()],
 * });
 */
export const evalScorers = {
  exact,
  contains,
  predicate,
  judge,
};
