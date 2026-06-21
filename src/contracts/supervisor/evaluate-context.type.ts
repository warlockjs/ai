import type { AIError } from "../../errors/ai-error";
import type { Message } from "../conversation-message.type";
import type { Usage } from "../result/usage.type";
import type { ClassifierSnapshot } from "./classifier-context.type";
import type { IterationSnapshot } from "./iteration-snapshot.type";
import type { SupervisorInput } from "./supervisor-input.type";

/**
 * Per-branch summary passed to `evaluate` via
 * `EvaluateContext.result[intent]`. Carries exactly what `evaluate`
 * needs to judge the turn — the transformed output, timing, token
 * usage, and any per-branch error that didn't abort the sibling
 * dispatches.
 *
 * Distinct from `AgentBranchSnapshot` because it's the `evaluate`
 * contract, not the persistence contract — snapshots mirror the same
 * fields plus canonical timestamps and a frozen shape.
 */
export type EvaluateBranchResult = {
  /** Output after the per-agent `output` transformer (if any). */
  output: unknown;
  /** The resolved input string sent to the agent this iteration. */
  input: string;
  usage: Usage;
  durationMs: number;
  /**
   * Per-branch typed error. Set only when this specific branch
   * failed; sibling branches and the evaluate pass still run.
   */
  error?: AIError;
};

/**
 * Context passed to a supervisor's `evaluate` callback. Fires
 * retrospectively after the iteration's agent(s) have settled —
 * never before dispatch — so `result` is populated.
 *
 * `result` is a `Record` keyed by intent name (not an array) — see
 * design §10 for why: it keeps consumer code uniform whether one
 * agent or three ran, matches the `intents` config shape, and
 * expresses "didn't run this iteration" cleanly as key absence.
 *
 * @example
 * evaluate: (ctx) => {
 *   if (ctx.result.resolver?.output) { return { satisfied: true }; }
 *   if (!ctx.result.research) { return { reassignTo: "research" }; }
 *   return undefined;
 * }
 */
export type EvaluateContext<TState = Record<string, unknown>> = {
  iteration: number;
  /** The supervisor's original `execute(input)` value. */
  input: SupervisorInput;
  /**
   * Per-execute typed accumulator AFTER this iteration's intents
   * have merged their outputs. State-driven termination logic
   * (`return ctx.state.reply ? { satisfied: true } : undefined`)
   * lives here.
   */
  state: TState;
  /**
   * Outputs from this iteration's dispatched agents, keyed by intent
   * name. Absent key = didn't run this iteration. Always an object —
   * even single-agent iterations produce a one-key record.
   */
  result: Record<string, EvaluateBranchResult>;
  /**
   * Prior iterations' snapshots, in chronological order.
   *
   * Renamed from `history` (Q2).
   */
  iterations: IterationSnapshot[];
  /**
   * Read-only request-scoped bag supplied via
   * `execute(input, { context })`. Shallow-copied + frozen at intake
   * so callbacks can't mutate the caller's object. Defaults to a
   * frozen `{}` when no context was passed. NOT persisted in
   * snapshots — re-supply on `resume()`.
   */
  context: Readonly<Record<string, unknown>>;
  /**
   * Prior conversation messages supplied via
   * `execute(input, { history })`. Read-only — passed by reference, not
   * copied. Defaults to an empty array when no history was supplied.
   * NOT persisted in snapshots — re-supply on `resume()`.
   */
  history: ReadonlyArray<Message>;
  /**
   * Resolved natural-language objective from `SupervisorConfig.goal`.
   * `undefined` when the supervisor was configured without one.
   * Read-only. Especially useful for goal-aware satisfaction checks:
   * `evaluate` can compare `ctx.state` against `ctx.goal` semantics
   * without hardcoded strings.
   */
  goal?: string;
  /**
   * Forensic record of iter-0 classifier run (Phase 7 / decisions §37).
   * Present when `SupervisorConfig.classifier` was configured AND
   * iter 0 has completed (classifier mode supervisors only). Lets
   * `evaluate` factor the classification trail into satisfaction
   * checks without re-reading from state.
   */
  classifier?: Readonly<ClassifierSnapshot>;
};

/**
 * Verdict returned by `evaluate`. Fields may be combined:
 *
 * - `undefined` — trust the router/route; continue to the next
 *   iteration unchanged.
 * - `{ satisfied: true }` — terminate the run successfully.
 * - `{ reassignTo: string | string[] }` — override the next
 *   iteration's dispatch decision. Supports fan-out via array form.
 * - `{ feedback: string }` — inject reviewer feedback into the next
 *   iteration's composed input.
 *
 * Combining works exactly as expected: `{ reassignTo: "critic",
 * feedback: "focus on factual errors" }` forces a critic dispatch
 * with the feedback threaded into its input.
 */
export type EvaluateResult =
  | undefined
  | {
      satisfied?: boolean;
      reassignTo?: string | string[];
      feedback?: string;
    };
