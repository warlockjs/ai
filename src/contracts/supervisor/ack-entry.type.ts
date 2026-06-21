import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { AgentContract } from "../agent/agent.contract";
import type { Message } from "../conversation-message.type";
import type { RouteContext } from "./route-context.type";

/**
 * Receptionist callback — pure code that produces an acknowledgment
 * slice. Bare-callback shorthand for `AckRunEntry`. Use when the ack
 * doesn't need an LLM at all (templated greetings, deterministic
 * hedges based on `ctx.input` keywords, etc.).
 */
export type AckCallback<TState = Record<string, unknown>> = (
  ctx: RouteContext<TState>,
) => unknown | Promise<unknown>;

/**
 * Receptionist entry — LLM-driven form. Symmetric with `IntentEntry`,
 * gated to ack-relevant fields:
 *
 * - `agent` — the receptionist agent. Typically a small/fast model
 *   on a separate provider so its first-token latency genuinely
 *   undercuts the slow path.
 * - `placeholders` — values fed into the agent's `systemPrompt` template.
 * - `input` — overrides what the agent receives as its user message.
 * - `output` — Standard Schema; strip-validates the slice before merge.
 */
export type AckEntry<TState = Record<string, unknown>> = {
  agent: AgentContract<unknown>;
  placeholders?: (ctx: RouteContext<TState>) => Record<string, unknown>;
  input?: (ctx: RouteContext<TState>) => string;
  output?: StandardSchemaV1<unknown>;
  /**
   * Custom history slicer for the ack agent. When supplied, REPLACES
   * the default (which is empty — `historyWindow.ack` defaults to `0`,
   * since receptionists rarely need scroll-back). Override this when
   * the ack genuinely needs a turn or two of context.
   *
   * Precedence: entry `history` callback > `historyWindow.ack` >
   * empty.
   *
   * @example
   * ack: {
   *   agent: ackAgent,
   *   history: (ctx) => ctx.history.slice(-2),
   * }
   */
  history?: (ctx: RouteContext<TState>) => Message[] | ReadonlyArray<Message>;
};

/**
 * Receptionist entry — callback form. Same shape as `AckEntry` but
 * with `run` instead of `agent` — pure code, no LLM call. Mirrors
 * the `IntentRunEntry` / `IntentEntry` split on the intents map.
 */
export type AckRunEntry<TState = Record<string, unknown>> = {
  run: AckCallback<TState>;
  output?: StandardSchemaV1<unknown>;
};

/**
 * Union of accepted shapes for the supervisor's `ack` config field.
 * Three forms in order of conciseness:
 *
 * 1. **`AckEntry`** — `{ agent, placeholders?, input?, output? }`.
 *    LLM-driven receptionist (e.g. one that classifies the request
 *    and weaves the category into the ack: "Looking into your *shipping*
 *    question now"). Use a meaningfully faster model + provider than
 *    the slow path the ack is masking — same model = same queue,
 *    no win.
 *
 * 2. **`AckRunEntry`** — `{ run, output? }`. Pure-code callback that
 *    returns the slice. Use for templated/deterministic acks that
 *    don't need an LLM.
 *
 * 3. **`AckCallback`** — bare `(ctx) => slice`. Shorthand for the
 *    pure-code form when no schema is declared.
 *
 * **Receptionist mental model.** Whatever form, the ack acknowledges
 * receipt and indicates direction; it does NOT make decisions or
 * promise outcomes. The downstream specialists own the actual answer.
 *
 * **Runtime semantics:**
 * - Fires only when `iteration === 0 && !resumeFrom`. Resumes don't
 *   re-emit (the user already saw the original ack).
 * - Runs concurrently with phase A (router/route decision).
 * - Tokens stream via `supervisor.ack.streaming` (LLM form only —
 *   pure-code acks settle synchronously and emit just `.completed`).
 * - Output strip-merges into `state` BEFORE dispatched branches —
 *   specialist outputs override the receptionist on key collision.
 * - Loses gracefully — if ack hasn't settled by the time the
 *   iteration is otherwise ready to finalize, the slice drops with
 *   a warning log; the run completes regardless. Schema's
 *   `.optional()` covers it. Non-blocking by design.
 * - Failure surfaces on `report.ack.error` but never aborts the run.
 * - Usage rolls up into the supervisor's total; the ack agent's full
 *   report node lives in `result.report.children[]`.
 */
export type AckConfig<TState = Record<string, unknown>> =
  | AckEntry<TState>
  | AckRunEntry<TState>
  | AckCallback<TState>;
