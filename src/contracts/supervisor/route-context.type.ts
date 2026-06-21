import type { Message } from "../conversation-message.type";
import type { ClassifierSnapshot } from "./classifier-context.type";
import type { EvaluateResult } from "./evaluate-context.type";
import type { IterationSnapshot } from "./iteration-snapshot.type";
import type { SupervisorInput } from "./supervisor-input.type";

/**
 * Context passed to a supervisor's `route` callback (deterministic
 * dispatch mode) and also exposed to router-agent input composers
 * and per-agent `input` transformers.
 *
 * The context is read-only from the callback's perspective —
 * mutating it is a bug; consumers that need derived state should
 * build it in the callback body.
 *
 * @example
 * route: (ctx) => {
 *   if (ctx.iteration >= 5) { return END; }
 *   if (ctx.state.draft && !ctx.state.critique) { return "critic"; }
 *   return "writer";
 * }
 */
export type RouteContext<TState = Record<string, unknown>> = {
  /** Zero-indexed iteration number — turn 0 is the first run. */
  iteration: number;
  /**
   * The supervisor's original `execute(input)` value. Either a raw
   * string or a structured `Record<string, unknown>` payload — see
   * `SupervisorInput`.
   */
  input: SupervisorInput;
  /**
   * Per-execute typed accumulator. Updated after each iteration's
   * intents merge their outputs. Read-only from the route callback;
   * built up by intents themselves.
   */
  state: TState;
  /**
   * Every completed iteration's snapshot, in chronological order.
   * On turn 0 this is empty.
   *
   * Renamed from `history` (Q2).
   */
  iterations: IterationSnapshot[];
  /**
   * Reviewer feedback string produced by `evaluate.feedback` at the
   * end of the previous iteration. Visible to router/route only
   * (Q18 — feedback is router-targeted; not auto-injected into agent
   * placeholders). Absent on turn 0 and turns where evaluate didn't
   * return a feedback string.
   */
  feedback?: string;
  /**
   * Full previous-iteration evaluate verdict (raw). Available to
   * route callbacks that want the full shape (e.g. inspect
   * `reassignTo` in addition to `feedback`).
   */
  evaluateFeedback?: EvaluateResult;
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
   * Read-only.
   */
  goal?: string;
  /**
   * Forensic record of iter-0 classifier run (Phase 7 / decisions §37).
   * Present only when `SupervisorConfig.classifier` was configured
   * AND iter 0 has completed; `undefined` for iter-0 routing
   * decisions (classifier hasn't run yet) and for supervisors that
   * don't use classifier mode.
   */
  classifier?: Readonly<ClassifierSnapshot>;
};
