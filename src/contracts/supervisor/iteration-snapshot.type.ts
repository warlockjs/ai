import type { AIError } from "../../errors/ai-error";
import type { Usage } from "../result/usage.type";
import type { EvaluateResult } from "./evaluate-context.type";
import type { Next } from "./next.type";

/**
 * Per-branch snapshot captured during dispatch — one per intent that
 * ran in the iteration. The persistence-grade record of what each
 * agent did, kept frozen (`Readonly`) so consumers can safely pass
 * snapshots across async boundaries without defensive cloning.
 *
 * Keyed into `IterationSnapshot.result` by the intent name (the key
 * from the supervisor's `intents` config). Absent key = the intent
 * didn't dispatch this iteration.
 */
export type AgentBranchSnapshot = Readonly<{
  /** The `intents` map key that identified this dispatch. */
  intent: string;
  /** Resolved input string the agent/workflow received. */
  input: string;
  /** Output after the per-agent `output` transformer (if any). */
  output: unknown;
  usage: Usage;
  startedAt: string;
  endedAt: string;
  duration: number;
  /** Typed error if this branch failed — siblings still ran. */
  error?: AIError;
}>;

/**
 * Forensic record of the receptionist (`ackAgent`) run. Set on
 * `SupervisorReport.ack` only when an ack agent was configured AND the
 * run started fresh (resumes don't re-fire ack). Mirrors
 * `AgentBranchSnapshot` shape minus the per-iteration `intent` field —
 * ack is not an iterating intent, it's a one-shot kickoff.
 */
export type AckSnapshot = Readonly<{
  input: string;
  /** Ack output after schema validation (if `ackAgent.output` declared). */
  output: unknown;
  usage: Usage;
  startedAt: string;
  endedAt: string;
  duration: number;
  /**
   * Set when the ack agent failed. Run continues regardless — the
   * receptionist tripping doesn't stop the specialist from doing the
   * actual job.
   */
  error?: AIError;
}>;

/**
 * Origin of a dispatch decision, recorded for debugging and drift
 * analysis. `initialAgent` fires only on turn 0 when the supervisor
 * was configured to skip the router on the first iteration.
 */
export type DecisionSource = "route" | "router" | "initialAgent" | "classifier";

/**
 * Dispatch decision record — everything a reader needs to answer the
 * question "why did this iteration run these agents?" without
 * replaying the router agent.
 */
export type IterationDecision = Readonly<{
  source: DecisionSource;
  /** The raw routing value — string, string[], or END sentinel. */
  next: Next;
  /**
   * Router agents may include a `reasoning` field alongside `next`
   * in their output schema; when present it's preserved here.
   */
  reasoning?: string;
  /** Wall-clock time spent deciding (router call or callback). */
  durationMs: number;
}>;

/**
 * One full iteration's forensic record, written after the iteration
 * settles (agents returned, evaluate ran, state updated). The
 * `snapshots[]` array on `SupervisorReport` is the primary debug
 * artifact — users debugging routing bugs ask "why did it pick X on
 * turn 3?" and the answer is here.
 *
 * See design §10 for why `result` is a `Record` keyed by intent and
 * not an array — load-bearing design call, don't normalize.
 */
export type IterationSnapshot = Readonly<{
  /** Zero-indexed iteration number. */
  iteration: number;
  /**
   * Per-branch dispatch records keyed by intent. Empty object only
   * when the iteration terminated before dispatching (e.g. the very
   * first decision returned `END`).
   */
  result: Record<string, AgentBranchSnapshot>;
  decision: IterationDecision;
  /** Present only if `evaluate` ran this iteration. */
  evaluateVerdict?: EvaluateResult;
  /**
   * Supervisor state at the end of this iteration (after every
   * branch's strip-merge). Snapshot persistence stores this so
   * `resume()` can rehydrate state without replaying intents.
   *
   * Phase 3.4 (Stage 4b) — added as part of the state model
   * rollout.
   */
  state: Record<string, unknown>;
  /**
   * Raw `ctx.artifacts` bag captured at this iteration's merge point
   * — BEFORE `finalizeArtifacts` (or auto-spread) reshaped it into
   * state (Phase 8 / decisions §38). Pre-merge view; lets observers
   * inspect what the tools contributed before any transformation.
   *
   * Empty `{}` when no tool wrote artifacts this iteration. Frozen
   * (read-only). Reconstructable into a flat aggregate by consumers
   * who want a run-level view: `snapshots.map(s => s.artifacts)`.
   */
  artifacts: Readonly<Record<string, unknown>>;
  startedAt: string;
  endedAt: string;
  duration: number;
  /** Sum of router + every branch + evaluate (if evaluate is an agent). */
  usage: Usage;
  /** Iteration-level fatal error, if one terminated the loop here. */
  error?: AIError;
}>;
