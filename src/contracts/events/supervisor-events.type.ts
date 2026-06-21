import type { AIError } from "../../errors/ai-error";
import { Usage } from "../result";
import type { SupervisorResult } from "../result/supervisor-result.type";
import type {
  EvaluateResult,
  IterationSnapshot,
  Next,
  SupervisorInput,
} from "../supervisor";

/** Fires once at the start of every `supervisor.execute()` call. */
export type SupervisorStartingPayload = {
  supervisorName: string;
  input: SupervisorInput;
};

/** Fires at the top of each iteration, before routing decides. */
export type SupervisorIterationStartingPayload = { iteration: number };

/** Router mode only — emitted just before the router agent is invoked. */
export type SupervisorRouterDecidingPayload = { iteration: number };

/** Emitted after the route callback or router agent resolves. */
export type SupervisorRouterDecidedPayload = {
  iteration: number;
  next: Next;
  reasoning?: string;
  durationMs: number;
};

/** A dispatched agent/workflow is about to start this iteration. */
export type SupervisorAgentStartingPayload = {
  iteration: number;
  intent: string;
  input: string;
};

/**
 * Child-agent streaming token bubbled up through the supervisor so UI
 * consumers can render per-agent output in real time without wiring
 * into every child agent individually.
 */
export type SupervisorAgentStreamingPayload = {
  iteration: number;
  intent: string;
  delta: string;
};

/** A dispatched branch completed successfully. */
export type SupervisorAgentCompletedPayload = {
  iteration: number;
  intent: string;
  output: unknown;
  usage: { input: number; output: number; total: number };
  duration: number;
};

/**
 * A dispatched branch failed. Siblings continue — the supervisor
 * captures the error on the branch snapshot and lets `evaluate`
 * (or the default termination logic) decide the response.
 */
export type SupervisorAgentFailedPayload = {
  iteration: number;
  intent: string;
  error: AIError;
};

/**
 * Classifier (Phase 7 / decisions §37) is about to run on iter 0.
 * Fires once per fresh run when `SupervisorConfig.classifier` is
 * configured.
 */
export type SupervisorClassifierStartingPayload = { iteration: 0 };

/**
 * Classifier streamed a token. Fires only when the classifier is
 * an LLM agent AND the supervisor is being streamed at the top
 * level. Distinct from `supervisor.agent.streaming` so UI consumers
 * can render classifier tokens (or hide them) separately from
 * dispatched specialist tokens.
 */
export type SupervisorClassifierStreamingPayload = {
  delta: string;
};

/**
 * Classifier settled — `output` carries the final classifier output
 * (post-refine if a refine hook was configured); `intent` is the
 * dispatched intent name (absent when refine returned `END`);
 * `refined` indicates whether the refine hook changed the output.
 */
export type SupervisorClassifierCompletedPayload = {
  output: { intent?: string; reasoning?: string; confidence?: number };
  intent?: string;
  refined: boolean;
  halted: boolean;
  duration: number;
  usage?: Usage;
};

/**
 * Classifier failed (the agent / callback threw, or refine threw,
 * or refine returned an invalid intent). Run aborts with this error
 * surfaced on `result.error`.
 */
export type SupervisorClassifierFailedPayload = {
  error: AIError;
};

/**
 * Receptionist agent emitted a token. Fires only when an `ackAgent`
 * is configured AND iteration 0 is in progress. Semantically distinct
 * from `supervisor.agent.streaming` so UIs can render ack tokens as
 * the user-facing first reply without filtering by intent name.
 */
export type SupervisorAckStreamingPayload = {
  delta: string;
};

/**
 * Receptionist agent settled. Fires once per run when an `ackAgent`
 * is configured. `output` is the raw agent output (pre-strip-merge);
 * `error` is set when the ack agent failed (run continues either way).
 */
export type SupervisorAckCompletedPayload = {
  output?: unknown;
  usage?: Usage;
  duration: number;
  error?: AIError;
};

/** The `evaluate` callback returned — verdict may be `undefined`. */
export type SupervisorEvaluateVerdictPayload = {
  iteration: number;
  verdict: EvaluateResult;
};

/**
 * An iteration settled — `snapshot` is the frozen forensic record
 * written to history and (when `store` is set) the KV snapshot.
 */
export type SupervisorIterationCompletedPayload = {
  iteration: number;
  snapshot: IterationSnapshot;
};

/** The run was aborted via `AbortSignal`. */
export type SupervisorCancelledPayload = {
  cancelledAt: string;
  reason?: string;
};

/** The run terminated successfully — result is the final value. */
export type SupervisorCompletedPayload<TOutput = unknown> = {
  result: SupervisorResult<TOutput>;
};

/**
 * The run terminated with a typed error surfaced on `result.error`.
 * Cancellation emits `supervisor.cancelled` instead.
 */
export type SupervisorErrorPayload = { error: AIError };
