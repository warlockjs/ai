import type { AIError } from "../../errors/ai-error";
import type { Usage } from "./usage.type";

/**
 * Minimal shape every execution result satisfies. Used as the upper
 * bound on `ExecutableContract`'s `TResult` generic so the contract
 * can promise the fields every caller needs regardless of which
 * primitive ran.
 *
 * Timing metadata now lives on each primitive's `report` field (see
 * `ExecutionReport`); `duration` was removed from this base to avoid
 * two sources of truth.
 *
 * @example
 * function summarize(result: BaseResult) {
 *   console.log(`${result.usage.total} tokens, ${result.error ? "failed" : "ok"}`);
 * }
 */
export type BaseResult = {
  /** Typed AI error if the execution failed, undefined on success. */
  error?: AIError;
  /** Aggregated token usage across the execution. */
  usage: Usage;
};
