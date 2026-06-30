/**
 * Default number of repair re-asks the judge preset performs when the
 * model's first verdict fails to parse / validate. Two attempts balances
 * resilience against latency — a corrupted-JSON judge usually recovers on
 * the first re-ask, and a model that still can't comply after two tries is
 * unlikely to on a third.
 */
export const JUDGE_DEFAULT_REPAIR_ATTEMPTS = 2;

/**
 * Fine-grained configuration for the judge-safe agent preset. The boolean
 * shorthand (`judge: true`) is equivalent to `judge: {}` — every field
 * below falls back to its resilient default.
 *
 * The preset targets structured-output *judges* (LLM-as-judge graders,
 * verdict classifiers) running on models that emit malformed JSON under
 * load — notably the Amazon Nova family, which wraps verdicts in fenced
 * blocks, prepends prose, or trails commentary. It trades strictness for
 * resilience (see {@link AgentConfig.judge}).
 */
export type JudgeConfig = {
  /**
   * How many repair re-asks to perform when the verdict fails to parse or
   * validate. Defaults to {@link JUDGE_DEFAULT_REPAIR_ATTEMPTS}. Still
   * bounded by the agent's `maxTrips` cap, so a stuck model can never loop
   * forever. Set `0` to disable repair while keeping the lenient parser and
   * never-throw guarantee.
   */
  repairAttempts?: number;
};
