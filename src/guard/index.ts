// @warlock.js/ai — content-intelligence guardrails (PII / topic /
// injection / moderation) for `@warlock.js/ai`.
//
// Importing this package registers `ai.guardrail(...)` (with the detector
// factories attached as `.pii` / `.topic` / `.injection` / `.moderation`) onto
// the shared `ai` namespace via module augmentation — no `@warlock.js/ai`
// source is modified. The standalone `guard` factory and the bare detector
// factories are also exported by name for callers who prefer explicit imports.

// Side-effect: register `ai.guardrail` + type the augmentation.
import "./guardrail";

// Factory
export { guard } from "./guard";
export type { FlagRecord } from "./guard";
export { guardrail } from "./guardrail";
export type { GuardrailFactory } from "./guardrail";

// Contracts — verdict + action model
export type {
  GuardrailAction,
  GuardrailMatch,
  GuardrailPhase,
  GuardrailVerdict,
} from "./contracts";

// Contracts — detector + factory options
export type {
  GuardOptions,
  GuardrailBlockEvent,
  GuardrailDetector,
  GuardrailDetectorContext,
  GuardrailEscalation,
  InjectionDetectorOptions,
  OpenAiClientLike,
  OpenAiModerationCreateBody,
  OpenAiModerationOptions,
  OpenAiModerationResponse,
  OpenAiModerationResult,
  PiiCategory,
  PiiDetectorOptions,
  TopicFilterOptions,
} from "./contracts";

// Detectors
export { injection, moderation, pii, topic } from "./detectors";

// Errors (re-exported `GuardrailViolationError` + the curated install string)
export { GuardrailViolationError, OPENAI_INSTALL_INSTRUCTIONS } from "./errors";
export type { GuardrailViolationErrorOptions } from "./errors";
