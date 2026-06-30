/**
 * Where a detector is running. Widens the core guardrail phase
 * (`"input" | "output"`) with a third value, `"tool"`, for detectors that
 * inspect the arguments the model produced for a tool call. Reused on the
 * `GuardrailViolationError.phase` surfaced to callers and on any emitted
 * escalation event.
 */
export type GuardrailPhase = "input" | "output" | "tool";

/**
 * The four actions a detector can return, the discriminator of
 * {@link GuardrailVerdict}.
 *
 * - `allow`  — content is clean; continue to the next detector.
 * - `redact` — rewrite the inspected text and continue.
 * - `block`  — reject the trip / tool call with a `GuardrailViolationError`.
 * - `flag`   — allow the content but record the match for a downstream observer.
 *
 * `type` is always the discriminator — never `kind`.
 */
export type GuardrailAction = "allow" | "redact" | "block" | "flag";

/**
 * A single thing a detector matched inside the inspected text. Surfaced in
 * logs, events, and on `redact` / `flag` verdicts so an operator can see
 * *what* tripped a rule without re-running the detector.
 */
export interface GuardrailMatch {
  /**
   * The detector rule that produced the match, namespaced under the
   * detector — e.g. `"pii.ssn"`, `"topic.deny.medical"`,
   * `"injection.jailbreak"`.
   */
  readonly rule: string;
  /**
   * Inclusive `[start, end]` character offsets into the inspected text,
   * when the detector can locate the match. Omitted for whole-text
   * verdicts (e.g. an allow-list miss or a moderation-model category).
   */
  readonly span?: readonly [start: number, end: number];
  /**
   * Free-form category surfaced in logs and events and substituted into a
   * redaction `mask` template — e.g. `"ssn"`, `"email"`, `"violence"`.
   */
  readonly label?: string;
}

/**
 * The verdict a {@link GuardrailDetector} returns from `check()` — a
 * discriminated union with exactly one {@link GuardrailAction} per shape.
 * The factory folds a detector array and acts on the first non-`allow`
 * verdict (short-circuit, in registration order).
 */
export type GuardrailVerdict =
  | {
      /** Content is clean; continue to the next detector. */
      readonly type: "allow";
    }
  | {
      /** Rewrite the inspected text and continue. */
      readonly type: "redact";
      /** The inspected text with every match replaced (detector-produced). */
      readonly text: string;
      /** Human-readable explanation of what was redacted and why. */
      readonly reason: string;
      /** The matches the detector replaced. */
      readonly matches: readonly GuardrailMatch[];
    }
  | {
      /** Reject the trip / tool call. */
      readonly type: "block";
      /** Human-readable reason surfaced on `GuardrailViolationError.reason`. */
      readonly reason: string;
      /** The matches that triggered the block, when known. */
      readonly matches?: readonly GuardrailMatch[];
      /**
       * Ask the host to route this block to a human-review surface. When
       * `true`, the factory awaits `escalation.onBlock` before throwing.
       * Default `false`.
       */
      readonly escalate?: boolean;
    }
  | {
      /** Allow the content but record the match for a downstream observer. */
      readonly type: "flag";
      /** Human-readable explanation of what was flagged. */
      readonly reason: string;
      /** The matches the detector recorded. */
      readonly matches: readonly GuardrailMatch[];
    };
