// Verdict + action model
export type {
  GuardrailAction,
  GuardrailMatch,
  GuardrailPhase,
  GuardrailVerdict,
} from "./verdict.type";

// Detector contract
export type {
  GuardrailDetector,
  GuardrailDetectorContext,
  SyncGuardrailDetector,
} from "./guardrail.contract";

// Optional OpenAI moderation client (structural view of the lazy peer)
export type {
  OpenAiClientLike,
  OpenAiModerationCreateBody,
  OpenAiModerationResponse,
  OpenAiModerationResult,
} from "./openai-client.contract";

// Factory + detector options
export type {
  GuardOptions,
  GuardrailBlockEvent,
  GuardrailEscalation,
  InjectionDetectorOptions,
  OpenAiModerationOptions,
  PiiCategory,
  PiiDetectorOptions,
  TopicFilterOptions,
} from "./guard-options.type";
