import type { MiddlewareTripContext } from "../../contracts/middleware/middleware-context.type";
import type { GuardrailDetector } from "./guardrail.contract";
import type { OpenAiClientLike } from "./openai-client.contract";
import type {
  GuardrailAction,
  GuardrailMatch,
  GuardrailPhase,
} from "./verdict.type";

/**
 * The payload handed to {@link GuardrailEscalation.onBlock} when a detector
 * returns `{ type: "block", escalate: true }`. The factory builds it just
 * before throwing the `GuardrailViolationError`, so a host can route the
 * hard block to a human-review surface.
 */
export interface GuardrailBlockEvent {
  /** Where the block fired: input prompt, output, or tool args. */
  readonly phase: GuardrailPhase;
  /** The detector's human-readable reason. */
  readonly reason: string;
  /** The matches that triggered the block, when the detector reported them. */
  readonly matches?: readonly GuardrailMatch[];
  /** The live middleware trip context (state, messages, agent, model, signal). */
  readonly ctx: MiddlewareTripContext;
}

/**
 * Escalation seam for composing a hard block with a human-review surface.
 *
 * The callback fires **only** for a verdict of `{ type: "block", escalate:
 * true }`, awaited *before* the `GuardrailViolationError` is thrown. It is a
 * plain callback by design — `ai-guard` takes no dependency on the deferred
 * human-step machinery; the host wires its own review queue / resume loop
 * inside `onBlock`.
 */
export interface GuardrailEscalation {
  /** Route a `{ type: "block", escalate: true }` verdict to a human. */
  onBlock?(event: GuardrailBlockEvent): void | Promise<void>;
}

/**
 * Configuration for the {@link guard} factory (surfaced as
 * `ai.guardrail(options)`). Each phase array runs in registration order;
 * the first non-`allow` verdict decides the action for that phase.
 *
 * At least one of `input` / `output` / `tool` should be supplied — a guard
 * with no detectors is a no-op middleware.
 */
export interface GuardOptions {
  /**
   * Override the middleware name — surfaces on
   * `GuardrailViolationError.guardrail` and as the `ctx.state` namespace so
   * operators can tell two guards apart. Default `"guardrail"`.
   */
  name?: string;
  /**
   * Detectors run on the outbound prompt at `trip.before`.
   *
   * **Input redaction is not supported in v1:** the core `trip.before` hook
   * can only short-circuit, not rewrite-and-continue, so a `redact` verdict
   * here is treated as a `block`. Input detectors are effectively
   * `block` / `flag` only.
   */
  input?: readonly GuardrailDetector[];
  /** Detectors run on `response.content` at `trip.after`. Support `redact`. */
  output?: readonly GuardrailDetector[];
  /**
   * Detectors run on `JSON.stringify(toolArgs)` at `tool.before`. A
   * `redact` verdict here is treated as a `block` (silently rewriting tool
   * arguments changes side-effects unpredictably).
   */
  tool?: readonly GuardrailDetector[];
  /**
   * The tool names the `tool` detectors apply to. Omit to apply to every
   * tool. When set, the middleware's `tool` hooks are scoped via the core
   * `forTool(toolNames, mw)` helper; `trip` hooks are unaffected.
   */
  toolNames?: string | readonly string[];
  /** Compose a `{ type: "block", escalate: true }` verdict with a human. */
  escalation?: GuardrailEscalation;
}

/**
 * The PII categories the built-in `pii` detector can scan for. Each is a
 * linear (anchored, no nested quantifiers) regex — safe against catastrophic
 * backtracking.
 */
export type PiiCategory = "ssn" | "email" | "phone" | "credit-card" | "ipv4";

/**
 * Options for the built-in `pii` detector (`ai.guardrail.pii`). All built-in
 * PII matching is regex / exact-string only — zero runtime dependency.
 */
export interface PiiDetectorOptions {
  /** Which categories to scan for. Default: every {@link PiiCategory}. */
  detect?: readonly PiiCategory[];
  /** What to do on a match. Default `"redact"`. */
  onMatch?: Extract<GuardrailAction, "redact" | "block" | "flag">;
  /**
   * Replacement template used on `redact`. Supports the `{label}` token,
   * substituted with the matched category — e.g. `"[REDACTED:{label}]"`.
   * Default masks the matched span with a fixed placeholder.
   */
  mask?: string;
  /** Extra exact-string terms to treat as PII alongside the built-in regexes. */
  dictionary?: readonly string[];
}

/**
 * Options for the built-in `topic` filter (`ai.guardrail.topic`). Matches a
 * case-insensitive substring or a `RegExp` against the inspected text.
 */
export interface TopicFilterOptions {
  /**
   * Deny-list terms / phrases. A `string` matches case-insensitively as a
   * substring; a `RegExp` is tested as-is. Any hit triggers `onMatch`.
   */
  deny?: readonly (string | RegExp)[];
  /**
   * Allow-list terms / phrases. When set, text matching **none** of these
   * triggers `onMatch` (an allow-list miss).
   */
  allow?: readonly (string | RegExp)[];
  /** Action on a deny hit (or an allow-list miss). Default `"block"`. */
  onMatch?: Extract<GuardrailAction, "block" | "flag">;
  /** Override the verdict's human-readable reason. */
  reason?: string;
}

/**
 * Options for the built-in `injection` detector (`ai.guardrail.injection`).
 * Matches a built-in set of jailbreak / prompt-injection marker phrases,
 * extensible with caller-supplied markers.
 */
export interface InjectionDetectorOptions {
  /**
   * Extra marker phrases beyond the built-in jailbreak / prompt-injection
   * set. A `string` matches case-insensitively as a substring; a `RegExp`
   * is tested as-is.
   */
  markers?: readonly (string | RegExp)[];
  /**
   * Action on a match. Default `"flag"` — callers commonly escalate to
   * `"block"` on the input phase.
   */
  onMatch?: Extract<GuardrailAction, "block" | "flag">;
}

/**
 * Options for the optional `moderation` detector (`ai.guardrail.moderation`),
 * backed by a lazily-imported `openai` peer. Importing `@warlock.js/ai`
 * never forces `openai` to resolve; the detector throws a curated install
 * string on first `check()` when the SDK is absent.
 */
export interface OpenAiModerationOptions {
  /**
   * A pre-built OpenAI-compatible client (any object matching
   * {@link OpenAiClientLike}, including a real `OpenAI` instance). When
   * supplied, the detector calls it directly and never imports the SDK —
   * the bring-your-own-client / test escape hatch.
   */
  client?: OpenAiClientLike;
  /** OpenAI API key. Reads `OPENAI_API_KEY` from the environment when omitted. */
  apiKey?: string;
  /** Moderation model to call. Default `"omni-moderation-latest"`. */
  model?: string;
  /**
   * Categories that escalate to `block`; every other flagged category
   * produces a `flag` verdict instead. Omit to `flag` on any category.
   */
  blockOn?: readonly string[];
}
