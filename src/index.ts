export * from "./agent";
export { ai } from "./ai";
export type { Ai } from "./ai";
export * from "./batch";
export * from "./checkpoint";
export * from "./config";
export * from "./contracts";
export * from "./errors";
export * from "./eval";
// Human-in-the-loop tool approval (interrupt / resume) — public surface of
// the `ai.human.*` namespace. The runtime namespace is mounted on `ai` in
// `./ai`; these are the standalone factories, errors, and contract types.
export { humanApproval } from "./human/human-approval";
export { evaluatePolicy } from "./human/policy";
export type { PolicyVerdict } from "./human/policy";
export { resume } from "./human/resume";
export {
  interruptMemory,
  interruptPg,
  interruptRedis,
} from "./human/stores";
export type {
  PgInterruptOptions,
  RedisInterruptOptions,
} from "./human/stores";
export {
  ApprovalRejectedError,
  InterruptSuspendedError,
} from "./human/errors";
export type {
  ApprovalRejectedErrorOptions,
  HumanErrorCode,
  InterruptSuspendedErrorOptions,
} from "./human/errors";
export type {
  ApprovalDecision,
  ApprovalDecisionType,
  ApprovalHandler,
  ApprovalRequest,
  ApprovalRequestContext,
  HumanApprovalOptions,
  InterruptPolicy,
  InterruptStore,
  PendingInterrupt,
  PendingInterruptStatus,
  PgClientLike,
  PolicyContext,
  RedisClientLike,
  ResumeOptions,
  ResumeResult,
} from "./human/contracts";
// Content-intelligence guardrails (`ai.guardrail.*`). Mounted on `ai` in `./ai`;
// these are the standalone factory, detectors, and contract types. (`GuardrailViolationError`
// + its options type are already exported from "./errors".)
export { guard } from "./guard/guard";
export type { FlagRecord } from "./guard/guard";
export { guardrail } from "./guard/guardrail";
export type { GuardrailFactory } from "./guard/guardrail";
export { injection, moderation, pii, topic } from "./guard/detectors";
export { OPENAI_INSTALL_INSTRUCTIONS } from "./guard/errors";
export type {
  GuardOptions,
  GuardrailAction,
  GuardrailBlockEvent,
  GuardrailDetector,
  GuardrailDetectorContext,
  GuardrailEscalation,
  GuardrailMatch,
  GuardrailPhase,
  GuardrailVerdict,
  InjectionDetectorOptions,
  OpenAiClientLike,
  OpenAiModerationCreateBody,
  OpenAiModerationOptions,
  OpenAiModerationResponse,
  OpenAiModerationResult,
  PiiCategory,
  PiiDetectorOptions,
  SyncGuardrailDetector,
  TopicFilterOptions,
} from "./guard/contracts";
export * from "./memory";
export * from "./middleware";
// Observe — generic, panoptic-agnostic observability seam. Observability
// tools (panoptic, OTel, …) implement `Observer` and register themselves
// via `registerObserver`, so flows can route their completed reports
// without core importing any tool. `AIConfig` is exported (as an
// augmentable interface) from "./config" above so those tools can attach
// their own opaque config slot via declaration merging.
export {
  getObservers,
  isObserveAll,
  registerObserver,
  resolveObservers,
  setObserveAll,
} from "./observe";
export type { FlowObserveOption, Observer } from "./observe";
export * from "./mock";
export * from "./model";
export * from "./object-stream";
export * from "./orchestrator";
export * from "./planner";
export * from "./prompt";
export * from "./prompts";
export * from "./rag";
export * from "./security";
export * from "./serve";
export * from "./skills";
export * from "./snapshot";
export * from "./supervisor";
// Team — sugar over the supervisor (manager + role members + quality gate).
export { team } from "./team";
export type { TeamConfig, TeamGate, TeamGateFn, TeamMemberValue } from "./contracts/team";
export * from "./system-prompt";
export * from "./tool";
export * from "./utils";
export * from "./vcr";
export * from "./workflow";

// Testing matchers. The pure, library-agnostic verdict functions and the
// `AiMatchers` type carry no `vitest` coupling and ship eagerly. The
// matcher *registration* (`registerAiMatchers`) is surfaced through the
// lazy bridge in `./testing/register-lazy`, which defers the `vitest`
// import (a devDependency) to call time — so importing `@warlock.js/ai`
// in production never pulls in `vitest`, while test code can still call
// it straight off the package root.
export {
  matchConverge,
  matchOutputShape,
  matchPassStep,
  matchRouteTo,
} from "./testing/matcher-logic";
export type { MatcherVerdict } from "./testing/matcher-logic";
export type { AiMatchers } from "./testing/matchers";
export { registerAiMatchers } from "./testing/register-lazy";
