import { dataset } from "./dataset";
import { judge } from "./judge-scorer";
import { fromJSON, toJSON } from "./report-json";
import { toJUnit } from "./report-junit";
import { contains, exact, predicate } from "./scorers";

// Runner — wired into AgentContract.eval() by the agent factory.
export { runEval } from "./eval-runner";

// Scorer factories — re-exported individually for direct import.
export { contains, exact, predicate } from "./scorers";
export type { EvalPredicate } from "./scorers";
export { judge } from "./judge-scorer";

// Dataset primitive — feeds `agent.eval({ cases })`.
export { dataset } from "./dataset";
export type {
  DatasetContract,
  DatasetEntry,
  DatasetOptions,
} from "./dataset.type";

// Regression diff + CI reporters (pure, runner-decoupled).
export { diff } from "./regression";
export { toJSON, fromJSON } from "./report-json";
export { toJUnit } from "./report-junit";

/**
 * Built-in eval scorer factories plus the CI reporters, surfaced on
 * `ai.eval.*`.
 *
 * Scorers:
 * - `exact()` — pass when output equals the case `expected` (trimmed,
 *   case-insensitive; structured values compared by canonical JSON).
 * - `contains()` — pass when `expected` appears as a substring.
 * - `predicate(fn)` — wrap an arbitrary boolean assertion.
 * - `judge(config)` — LLM-as-judge scoring against a rubric.
 *
 * Reporters / serialization (pure functions over a finished `EvalReport`):
 * - `toJUnit(report)` — JUnit-XML artifact for CI ingestion.
 * - `toJSON(report)` / `fromJSON(serialized)` — round-trippable snapshot;
 *   today's report becomes tomorrow's `baseline`.
 *
 * @example
 * await myAgent.eval({
 *   cases: [{ name: "q", input: "Capital of Egypt?", expected: "Cairo" }],
 *   scorers: [ai.eval.contains()],
 * });
 *
 * @example
 * const report = await myAgent.eval({ cases: ds, scorers: [ai.eval.exact()] });
 * await writeFile("./report.junit.xml", ai.eval.toJUnit(report));
 */
export const evalScorers = {
  exact,
  contains,
  predicate,
  judge,
  toJUnit,
  toJSON,
  fromJSON,
};
