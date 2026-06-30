// Human-in-the-loop tool approval (interrupt / resume) — the public surface
// of the `ai.human.*` namespace, re-exported from the `@warlock.js/ai` root
// barrel. The `ai.human.*` runtime namespace itself is assembled in
// `./register` and mounted natively onto the shared `ai` object in `../ai`.

// Assembled namespace object (mounted onto `ai.human` in `../ai`).
export { human } from "./register";

// Contracts
export type {
  ApprovalDecision,
  ApprovalDecisionType,
  ApprovalHandler,
  ApprovalRequest,
  ApprovalRequestContext,
  InterruptPolicy,
  PolicyContext,
} from "./contracts";
export type {
  InterruptStore,
  PendingInterrupt,
  PendingInterruptStatus,
  PgClientLike,
  RedisClientLike,
} from "./contracts";
export type { HumanApprovalOptions } from "./contracts";
export type { ResumeOptions, ResumeResult } from "./contracts";

// Middleware
export { humanApproval } from "./human-approval";

// Policy
export { evaluatePolicy } from "./policy";
export type { PolicyVerdict } from "./policy";

// Stores
export { interruptMemory, interruptPg, interruptRedis } from "./stores";
export type { PgInterruptOptions, RedisInterruptOptions } from "./stores";

// Resume
export { resume } from "./resume";

// Errors
export {
  ApprovalRejectedError,
  InterruptSuspendedError,
} from "./errors";
export type {
  ApprovalRejectedErrorOptions,
  HumanErrorCode,
  InterruptSuspendedErrorOptions,
} from "./errors";
