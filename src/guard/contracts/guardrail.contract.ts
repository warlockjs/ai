import type { MiddlewareTripContext } from "../../contracts/middleware/middleware-context.type";
import type { GuardrailPhase, GuardrailVerdict } from "./verdict.type";

/**
 * The stable context every detector receives on each `check()` — the phase
 * it is running at plus the live middleware trip context.
 *
 * A detector reads `phase` to branch on *where* it is running (e.g. an
 * injection detector escalating to `block` on `"input"` but only `flag` on
 * `"output"`), and `ctx` for the surrounding run identity (`state`,
 * `messages`, `agent`, `model`, `signal`). A detector must never mutate
 * `ctx` — it is a read-only view; the factory owns all pipeline effects.
 */
export interface GuardrailDetectorContext {
  /** Where this detector is running: input prompt, output, or tool args. */
  readonly phase: GuardrailPhase;
  /** The live middleware trip context (state, messages, agent, model, signal). */
  readonly ctx: MiddlewareTripContext;
}

/**
 * A guardrail detector — the unit of content intelligence. Inspects a piece
 * of text and returns a {@link GuardrailVerdict}. Sync or async (an async
 * `check` routes to an external moderation API).
 *
 * A detector has **no** knowledge of hooks, ordering, or `ctx.state`
 * mutation — the {@link guard} factory is the thin adapter that runs
 * detectors at the right hook points and translates verdicts into the
 * pipeline's throw / return / record mechanics.
 *
 * @example
 * const noShouting: GuardrailDetector = {
 *   name: "no-shouting",
 *   check(text) {
 *     return text === text.toUpperCase() && text.length > 0
 *       ? { type: "flag", reason: "all caps", matches: [{ rule: "no-shouting" }] }
 *       : { type: "allow" };
 *   },
 * };
 */
export interface GuardrailDetector {
  /**
   * Kebab-case identifier, used as the rule prefix in {@link GuardrailMatch}
   * and surfaced in logs / events — e.g. `"pii"`, `"topic"`, `"injection"`,
   * `"moderation.openai"`.
   */
  readonly name: string;
  /**
   * Inspect `text` and return a verdict. Receives the
   * {@link GuardrailDetectorContext} so it can branch on the phase or read
   * the surrounding run state.
   */
  check(
    text: string,
    detectorCtx: GuardrailDetectorContext,
  ): GuardrailVerdict | Promise<GuardrailVerdict>;
}

/**
 * A {@link GuardrailDetector} whose `check()` is **synchronous** — it returns a
 * {@link GuardrailVerdict} directly, never a `Promise`. Used by the built-in
 * zero-dependency detectors (`pii`, `topic`, `injection`) that inspect text
 * with pure string / regex matching and have no async work to do.
 *
 * Because the return type is covariant, a `SyncGuardrailDetector` is
 * structurally assignable to {@link GuardrailDetector}: anything that accepts a
 * `GuardrailDetector` (the guard factory's `input` / `output` / `tool` arrays)
 * accepts a `SyncGuardrailDetector` unchanged. Callers that hold the concrete
 * sync type additionally get to read `verdict.type` / `.matches` / `.text`
 * without awaiting.
 */
export interface SyncGuardrailDetector extends GuardrailDetector {
  /**
   * Inspect `text` and return a verdict synchronously. Receives the
   * {@link GuardrailDetectorContext} so it can branch on the phase or read
   * the surrounding run state.
   */
  check(text: string, detectorCtx: GuardrailDetectorContext): GuardrailVerdict;
}
