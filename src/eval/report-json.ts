import type { EvalReport } from "../contracts/agent/eval.type";

/**
 * Serialize an {@link EvalReport} to a pretty-printed JSON string — a
 * round-trippable snapshot suitable for committing as the next run's
 * baseline (`agent.eval({ baseline: fromJSON(...) })`).
 *
 * Pure. The whole report is emitted verbatim; `result` payloads,
 * per-case `scores`, timings, and any attached `regression` block are all
 * preserved, so a parsed report drives regression diffing exactly as the
 * in-memory one would.
 *
 * @example
 * await writeFile("./eval/baseline.json", toJSON(report));
 */
export function toJSON(report: EvalReport): string {
  return JSON.stringify(report, undefined, 2);
}

/**
 * Parse a string produced by {@link toJSON} back into an
 * {@link EvalReport}. The inverse of `toJSON` — `fromJSON(toJSON(r))`
 * reproduces `r`'s data (functions such as scorers were never part of the
 * serialized report, so the round-trip is over plain data only).
 *
 * @example
 * const baseline = fromJSON(await readFile("./eval/baseline.json", "utf8"));
 */
export function fromJSON<TOutput = unknown>(serialized: string): EvalReport<TOutput> {
  return JSON.parse(serialized) as EvalReport<TOutput>;
}
