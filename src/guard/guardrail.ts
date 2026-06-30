import type { AgentMiddleware } from "../contracts/middleware/middleware.contract";
import type {
  GuardOptions,
  GuardrailDetector,
  InjectionDetectorOptions,
  OpenAiModerationOptions,
  PiiDetectorOptions,
  TopicFilterOptions,
} from "./contracts";
import { injection, moderation, pii, topic } from "./detectors";
import { guard } from "./guard";

/**
 * The callable `ai.guardrail` surface — the {@link guard} factory with the
 * built-in detector factories attached as methods, so the whole guardrail
 * vocabulary lives under one name:
 *
 * - `ai.guardrail(options)` — build the composed middleware.
 * - `ai.guardrail.pii(o?)` / `.topic(o)` / `.injection(o?)` / `.moderation(o?)`
 *   — build a detector to pass into the factory's `input` / `output` / `tool`
 *   arrays.
 *
 * @example
 * const policy = ai.guardrail({
 *   output: [ai.guardrail.pii({ onMatch: "redact" })],
 * });
 */
export interface GuardrailFactory {
  /** Build the composed guardrail {@link AgentMiddleware}. */
  (options: GuardOptions): AgentMiddleware;
  /** Built-in PII detector (regex + dictionary, zero runtime dep). */
  pii(options?: PiiDetectorOptions): GuardrailDetector;
  /** Built-in topic filter (allow / deny string | RegExp lists). */
  topic(options: TopicFilterOptions): GuardrailDetector;
  /** Built-in jailbreak / prompt-injection marker detector. */
  injection(options?: InjectionDetectorOptions): GuardrailDetector;
  /** Optional OpenAI-backed moderation detector (lazy `openai` peer). */
  moderation(options?: OpenAiModerationOptions): GuardrailDetector;
}

/**
 * The `ai.guardrail` value: the {@link guard} factory with the detector
 * factories assigned onto it. Built once and shared.
 */
export const guardrail: GuardrailFactory = Object.assign(guard, {
  pii,
  topic,
  injection,
  moderation,
});

// `ai.guardrail` is registered natively on the core `ai` object (in `../ai`),
// now that the guardrail suite ships inside `@warlock.js/ai`.
