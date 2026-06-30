import { extractUserText } from "../middleware/utils/extract-user-text";
import { forTool } from "../middleware/helpers/for-tool";
import type { AgentMiddleware } from "../contracts/middleware/middleware.contract";
import type {
  MiddlewareToolContext,
  MiddlewareTripContext,
} from "../contracts/middleware/middleware-context.type";
import type { ModelResponse } from "../contracts/model.contract";
import type {
  GuardOptions,
  GuardrailDetector,
  GuardrailEscalation,
  GuardrailMatch,
  GuardrailPhase,
  GuardrailVerdict,
} from "./contracts";
import { GuardrailViolationError } from "./errors";

/** Default middleware name when the caller supplies none. */
const DEFAULT_NAME = "guardrail";

/**
 * The `ctx.state` key under which a guard records its `flag` verdicts. The
 * value is an append-only array of {@link FlagRecord}, namespaced by the
 * middleware name so two guards on the same agent never collide and a
 * downstream observer (panoptic, the caller) can read the annotations
 * post-run.
 */
function flagsKey(name: string): string {
  return `${name}.flags`;
}

/**
 * One flagged match recorded into `ctx.state`. Mirrors the
 * {@link GuardrailVerdict} `flag` shape plus the phase it fired at, so an
 * observer can reconstruct *what* tripped *where* without re-running the
 * detector.
 */
export interface FlagRecord {
  /** The detector that produced the flag. */
  readonly detector: string;
  /** Where the detector was running. */
  readonly phase: GuardrailPhase;
  /** The detector's human-readable reason. */
  readonly reason: string;
  /** The matches the detector recorded. */
  readonly matches: readonly GuardrailMatch[];
}

/**
 * Append a `flag` record onto the namespaced `ctx.state` array, creating it
 * on first write. Never throws — recording is best-effort annotation.
 */
function recordFlag(
  ctx: MiddlewareTripContext,
  name: string,
  record: FlagRecord,
): void {
  const key = flagsKey(name);
  const existing = ctx.state.get(key);
  const flags = Array.isArray(existing) ? (existing as FlagRecord[]) : [];

  flags.push(record);
  ctx.state.set(key, flags);
}

/**
 * The outcome of folding a phase's detector array — what the hook should do
 * with the inspected text once every detector has had its say.
 *
 * - `allow`  — no detector objected; the hook continues untouched.
 * - `redact` — a detector returned rewritten `text`; the hook substitutes it
 *   (output / tool phases only — see {@link runDetectors}).
 * - `block`  — a detector rejected; the hook throws a
 *   {@link GuardrailViolationError} carrying `reason` / `matches` / `escalate`.
 *
 * `flag` verdicts never reach this type — they are recorded into `ctx.state`
 * as a side effect inside {@link runDetectors} and do not short-circuit the
 * fold, so a flagged-but-otherwise-clean run resolves to `allow`.
 */
type PhaseOutcome =
  | { readonly type: "allow" }
  | { readonly type: "redact"; readonly text: string }
  | {
      readonly type: "block";
      readonly reason: string;
      readonly matches?: readonly GuardrailMatch[];
      readonly escalate: boolean;
    };

/**
 * Run a phase's detector array over `text`, in registration order, and fold
 * the verdicts into a single {@link PhaseOutcome}.
 *
 * **Short-circuit.** The first non-`allow`/non-`flag` verdict (a `redact` or
 * `block`) decides the outcome and stops the fold — outer detectors never run
 * after one objects, matching the install-array ordering. `flag` verdicts are
 * recorded into `ctx.state` and the fold continues (allow-but-annotate).
 *
 * **Phase-aware redact downgrade.** A `redact` verdict is only honoured where
 * the seam supports rewrite-and-continue:
 * - `"output"` — `trip.after` may return a replacement `ModelResponse`, so the
 *   rewritten text is threaded out.
 * - `"input"`  — the core `trip.before` hook can only short-circuit (return a
 *   response) or throw; it has **no** rewrite-and-continue seam, so an input
 *   `redact` is downgraded to a `block` rather than silently passing the
 *   un-redacted prompt through. (Documented on {@link GuardOptions.input}.)
 * - `"tool"`   — silently rewriting tool arguments changes the call's
 *   side-effects unpredictably, so a tool `redact` is downgraded to a `block`
 *   (`tool-arg-redaction-unsupported`) rather than mutating what the tool runs.
 *
 * **Fail-open on detector fault.** A detector's `check()` rejecting is an
 * infrastructure fault, not a content violation — it is recorded as a `flag`
 * (`<detector>.error`) and the fold continues, so a moderation-API outage does
 * not abort every agent run.
 */
async function runDetectors(
  detectors: readonly GuardrailDetector[],
  text: string,
  phase: GuardrailPhase,
  ctx: MiddlewareTripContext,
  name: string,
): Promise<PhaseOutcome> {
  for (const detector of detectors) {
    let verdict: GuardrailVerdict;

    try {
      verdict = await detector.check(text, { phase, ctx });
    } catch (error) {
      // Infra fault — fail open: record and continue, never abort the run.
      recordFlag(ctx, name, {
        detector: detector.name,
        phase,
        reason: `detector "${detector.name}" threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
        matches: [],
      });

      continue;
    }

    if (verdict.type === "allow") {
      continue;
    }

    if (verdict.type === "flag") {
      recordFlag(ctx, name, {
        detector: detector.name,
        phase,
        reason: verdict.reason,
        matches: verdict.matches,
      });

      continue;
    }

    if (verdict.type === "redact") {
      if (phase === "output") {
        return { type: "redact", text: verdict.text };
      }

      // Input / tool phases have no safe rewrite-and-continue seam — downgrade
      // to a block so the un-redacted text is never threaded through.
      const reason =
        phase === "tool"
          ? "tool-arg-redaction-unsupported"
          : verdict.reason;

      return {
        type: "block",
        reason,
        matches: verdict.matches,
        escalate: false,
      };
    }

    // verdict.type === "block"
    return {
      type: "block",
      reason: verdict.reason,
      matches: verdict.matches,
      escalate: verdict.escalate ?? false,
    };
  }

  return { type: "allow" };
}

/**
 * Realize a `block` outcome: fire the escalation seam (when the verdict asked
 * for it) and throw the typed {@link GuardrailViolationError} on `result.error`.
 * Never returns — always throws.
 *
 * The core `GuardrailViolationError.phase` is typed `"input" | "output"`; this
 * package widens the surfaced `phase` with `"tool"` (a source-compatible third
 * value), so the construction site asserts the wider value through the options
 * shape the error already accepts at runtime.
 */
async function block(
  outcome: Extract<PhaseOutcome, { type: "block" }>,
  phase: GuardrailPhase,
  ctx: MiddlewareTripContext,
  name: string,
  escalation: GuardrailEscalation | undefined,
): Promise<never> {
  if (outcome.escalate) {
    await escalation?.onBlock?.({
      phase,
      reason: outcome.reason,
      matches: outcome.matches,
      ctx,
    });
  }

  throw new GuardrailViolationError(
    `guardrail "${name}" rejected ${phase} — ${outcome.reason}`,
    {
      // `phase` is widened to include "tool"; the error carries it verbatim.
      phase: phase as "input" | "output",
      reason: outcome.reason,
      guardrail: name,
    },
  );
}

/**
 * Build the composed **guardrail middleware** (surfaced as
 * `ai.guardrail(options)`) — one {@link AgentMiddleware} that runs the
 * configured detectors at three hook points and maps each
 * {@link GuardrailVerdict} onto the pipeline's throw / return / record
 * mechanics:
 *
 * - **`input`** detectors run at `trip.before` over the outbound prompt
 *   (`extractUserText(ctx.messages)`). `block` / `flag` only — the core
 *   `trip.before` seam cannot rewrite-and-continue, so a `redact` verdict here
 *   is downgraded to a `block`.
 * - **`output`** detectors run at `trip.after` over `response.content`. Full
 *   `allow` / `redact` / `block` / `flag` support — a `redact` returns a
 *   replacement `ModelResponse` with the rewritten `content`.
 * - **`tool`** detectors run at `tool.before` over `JSON.stringify(toolArgs)`.
 *   `block` / `flag`; a `redact` is downgraded to a `block`
 *   (`tool-arg-redaction-unsupported`). Scoped to `toolNames` via the core
 *   `forTool(toolNames, mw)` helper when set.
 *
 * **Verdict → action.** Detectors run in registration order; the first
 * `redact` / `block` short-circuits the phase. `block` throws a
 * {@link GuardrailViolationError} on `result.error` (never out of the
 * pipeline); `flag` records the match into `ctx.state` under `<name>.flags`
 * and continues; a `{ type: "block", escalate: true }` verdict awaits
 * `escalation.onBlock` before throwing. A detector that *throws* is treated as
 * an infra fault and fails open (recorded as a flag, run continues).
 *
 * @param options - The {@link GuardOptions}: per-phase detector arrays,
 *   optional `toolNames` scope, `escalation` seam, and `name` override.
 * @returns One {@link AgentMiddleware} to pass into `ai.agent({ middleware: [...] })`.
 *
 * @example
 * const policy = ai.guardrail({
 *   name: "compliance",
 *   input: [ai.guardrail.injection({ onMatch: "block" })],
 *   output: [ai.guardrail.pii({ onMatch: "redact", mask: "[REDACTED:{label}]" })],
 *   tool: [ai.guardrail.pii({ onMatch: "block" })],
 *   toolNames: ["send_email"],
 *   escalation: { async onBlock(e) { await reviewQueue.enqueue(e); } },
 * });
 *
 * const agent = ai.agent({ model, tools: [sendEmail], middleware: [policy] });
 */
export function guard(options: GuardOptions): AgentMiddleware {
  const name = options.name ?? DEFAULT_NAME;
  const input = options.input ?? [];
  const output = options.output ?? [];
  const tool = options.tool ?? [];
  const escalation = options.escalation;

  const middleware: AgentMiddleware = {
    name,
    trip: {
      async before(ctx: MiddlewareTripContext): Promise<void> {
        if (input.length === 0) {
          return;
        }

        const prompt = extractUserText(ctx.messages);

        if (!prompt) {
          return;
        }

        const outcome = await runDetectors(input, prompt, "input", ctx, name);

        if (outcome.type === "block") {
          await block(outcome, "input", ctx, name, escalation);
        }

        // `allow` (incl. any recorded flags) and a downgraded-but-impossible
        // input `redact` (already mapped to block above) fall through — the
        // real model call proceeds with the un-mutated prompt.
      },
      async after(
        ctx: MiddlewareTripContext,
        response: ModelResponse,
      ): Promise<void | ModelResponse> {
        if (output.length === 0 || !response.content) {
          return;
        }

        const outcome = await runDetectors(
          output,
          response.content,
          "output",
          ctx,
          name,
        );

        if (outcome.type === "block") {
          await block(outcome, "output", ctx, name, escalation);
        }

        if (outcome.type === "redact") {
          // `trip.after` may return a replacement response — thread the
          // rewritten content back so the caller never sees the original.
          return { ...response, content: outcome.text };
        }

        return;
      },
    },
  };

  // Only declare the `tool` hook map when there are tool detectors — an empty
  // `tool` array would otherwise make `forTool` scoping a no-op cost.
  if (tool.length > 0) {
    middleware.tool = {
      async before(ctx: MiddlewareToolContext): Promise<void> {
        const args = JSON.stringify(ctx.request.input);

        if (!args) {
          return;
        }

        const outcome = await runDetectors(tool, args, "tool", ctx, name);

        if (outcome.type === "block") {
          await block(outcome, "tool", ctx, name, escalation);
        }

        // A tool `redact` is downgraded to `block` inside `runDetectors`, so
        // `redact` is unreachable here; `allow`/`flag` fall through and the
        // real tool dispatch proceeds.
      },
    };
  }

  // Scope the `tool` hooks to the named tools when requested — `forTool`
  // leaves `trip` hooks untouched, so input/output detectors still fire for
  // every trip regardless of which tool is being dispatched.
  if (options.toolNames !== undefined && middleware.tool) {
    return forTool(options.toolNames, middleware);
  }

  return middleware;
}
