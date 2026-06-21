import type { AIError } from "../../errors/ai-error";
import type { AgentContract } from "../agent/agent.contract";
import type { Message } from "../conversation-message.type";
import type { EndSentinel } from "../end.type";
import type { Usage } from "../result/usage.type";
import type { StreamContract } from "../stream/stream.contract";
import type {
  StreamableExecutable,
  SupervisableExecutable,
  SupervisableExecuteOptions,
  SupervisableResult,
} from "./dispatch-context.type";
import type { SupervisorInput } from "./supervisor-input.type";

/**
 * Locked output shape every classifier must produce — agent or callback
 * form. `intent` is required and must match a key in the supervisor's
 * `intents` map; `reasoning` and `confidence` are optional universal
 * telemetry fields.
 *
 * Devs may extend this with arbitrary additional fields by declaring
 * a richer output schema on their classifier agent — those fields
 * strip-merge into supervisor state per the supervisor's `output`
 * schema. The framework only reserves the three fields below.
 *
 * **Confidence caveat.** LLM-reported `confidence` values are
 * notoriously poorly calibrated — a model that says `0.95` is wrong
 * roughly as often as one that says `0.85`. Use it as a soft signal
 * (alongside reasoning inspection, prior state, deterministic checks)
 * rather than as a hard threshold for control flow.
 *
 * @example
 * // Output schema for a customer-support classifier:
 * v.object({
 *   intent: v.enum(["billing", "shipping", "smalltalk"]),
 *   reasoning: v.string().optional(),
 *   confidence: v.number().optional(),
 *   // Domain-specific extension — strip-merges into state alongside.
 *   language: v.string().optional(),
 * })
 */
export type ClassifierOutput = {
  /** Required — must match a key in the supervisor's `intents` map. */
  intent: string;
  /** Optional reasoning trail — telemetry / refine signal. */
  reasoning?: string;
  /**
   * Optional self-reported confidence (0–1). See "Confidence caveat"
   * above — LLM-reported values are not well calibrated.
   */
  confidence?: number;
};

/**
 * Result of a `classifier.refine` callback (Phase 7 / decisions §37).
 * Lets the dev intercept the classifier's output and either (a) accept
 * it as-is, (b) override the dispatched intent, (c) merge additional
 * state, or (d) halt the run before any dispatch.
 *
 * - `undefined` → use classifier output unchanged.
 * - `END` (bare sentinel) → terminate the run; no dispatch, no slice
 *   merged from refine. The run completes with
 *   `terminatedBy: "classifier"`.
 * - `{ intent: "name", ...slice }` → override intent + shallow-merge
 *   slice into state. `intent` must match a registered intents key
 *   or runtime throws `SUPERVISOR_INVALID_ROUTE`.
 * - `{ intent: END, ...slice }` → terminate AFTER merging slice into
 *   state. Useful for "halt with reason" patterns where the dev
 *   wants the rejection reason to surface in `result.data`.
 * - `{ ...slice }` (no `intent` key) → keep classifier's intent;
 *   shallow-merge slice into state.
 */
export type ClassifierRefineResult =
  | undefined
  | EndSentinel
  | (Record<string, unknown> & { intent?: string | EndSentinel });

/**
 * Read-only context passed to a classifier callback or to a
 * classifier agent's per-call resolvers (`placeholders`, `input`,
 * `history`). Phase 7 / decisions §37.
 *
 * Mirrors `RouteContext` for the iter-0 prelude with one critical
 * exclusion: dispatch helpers (`intents.X.execute()` / `run` /
 * `stream`) are NOT exposed at classifier time — registered intents
 * have not dispatched yet; pre-running them from the classifier
 * would be confusing. The refine hook gets `run` / `stream` so the
 * "secondary classifier" pattern works (call another agent inline
 * to validate or override the primary classification).
 */
export type ClassifierContext<TState = Record<string, unknown>> = {
  /** Always `0` — classifier runs as the iter-0 prelude. */
  iteration: 0;
  /** The supervisor's original `execute(input)` value. */
  input: SupervisorInput;
  /** Empty `{}` at classifier time — no intent has dispatched yet. */
  state: TState;
  /** Read-only request-scoped bag from `execute(input, { context })`. */
  context: Readonly<Record<string, unknown>>;
  /** Prior conversation messages from `execute(input, { history })`. */
  history: ReadonlyArray<Message>;
  /** Cancellation signal — propagated from the `execute()` caller. */
  signal: AbortSignal;
  /** Resolved natural-language objective from `SupervisorConfig.goal`. */
  goal?: string;
};

/**
 * Context passed to `classifier.refine`. Same surface as
 * {@link ClassifierContext} plus the just-resolved classifier output
 * on `result.data`, plus `run` / `stream` (Phase 6 inline supervised
 * execution) so refine can spin up a secondary classifier or
 * validator without leaving the supervised flow.
 */
export type ClassifierRefineContext<TState = Record<string, unknown>> =
  ClassifierContext<TState> & {
    /** The classifier's just-resolved output, ready to refine. */
    result: { data: ClassifierOutput };
    /** Inline execute under supervision — see Phase 6 / decisions §36. */
    run: (
      executable: SupervisableExecutable,
      input: unknown,
      options?: SupervisableExecuteOptions,
    ) => Promise<SupervisableResult>;
    /** Inline stream under supervision — see Phase 6 / decisions §36. */
    stream: (
      executable: StreamableExecutable,
      input: unknown,
      options?: SupervisableExecuteOptions,
    ) => StreamContract<SupervisableResult>;
  };

/**
 * Object form of a classifier entry — agent variant. Use when you
 * need to override per-call `placeholders`, `input`, or `history`,
 * or attach a `refine` post-process hook.
 */
export type ClassifierAgentEntry<TState = Record<string, unknown>> = {
  agent: AgentContract<unknown>;
  /** Per-call placeholders for the agent's systemPrompt template. */
  placeholders?: (ctx: ClassifierContext<TState>) => Record<string, unknown>;
  /** Per-call input override; defaults to the supervisor's `ctx.input`. */
  input?: (ctx: ClassifierContext<TState>) => string;
  /**
   * Per-call history slicer. Defaults to the supervisor's
   * `historyWindow.agents` slice when omitted.
   */
  history?: (ctx: ClassifierContext<TState>) => Message[] | ReadonlyArray<Message>;
  /**
   * Optional post-classify hook. Receives the classifier's output on
   * `ctx.result.data`; can override intent, merge state, or halt
   * via `END`.
   */
  refine?: (
    ctx: ClassifierRefineContext<TState>,
  ) => Promise<ClassifierRefineResult> | ClassifierRefineResult;
};

/**
 * Object form of a classifier entry — pure-code callback variant.
 * Use when classification is deterministic (regex, keyword match,
 * prior-state inspection) and an LLM call would be wasteful.
 */
export type ClassifierRunEntry<TState = Record<string, unknown>> = {
  run: (
    ctx: ClassifierContext<TState>,
  ) => Promise<ClassifierOutput> | ClassifierOutput;
  refine?: (
    ctx: ClassifierRefineContext<TState>,
  ) => Promise<ClassifierRefineResult> | ClassifierRefineResult;
};

/**
 * Bare-callback shorthand — when classification is a pure function
 * with no need for a `refine` hook or other entry-form fields.
 */
export type ClassifierCallback<TState = Record<string, unknown>> = (
  ctx: ClassifierContext<TState>,
) => Promise<ClassifierOutput> | ClassifierOutput;

/**
 * Accepted shapes for `SupervisorConfig.classifier` (Phase 7 /
 * decisions §37). Mirrors the same flexibility as `intents` and
 * `router`:
 *
 * - `AgentContract` — bare agent shorthand. Output is parsed via
 *   the agent's own typed output schema.
 * - `ClassifierCallback` — bare function shorthand; deterministic
 *   classification.
 * - `ClassifierAgentEntry` — full object form for an agent
 *   classifier with overrides + optional `refine`.
 * - `ClassifierRunEntry` — full object form for a callback
 *   classifier with optional `refine`.
 *
 * Mutually exclusive with `initialAgent` at the factory level —
 * both answer "what runs first?" and coexistence is meaningless.
 * Composes with `router`, `route`, `evaluate`, `ack`,
 * `intent.next`, and Phases 5/6 features.
 */
export type ClassifierConfig<TState = Record<string, unknown>> =
  | AgentContract<unknown>
  | ClassifierCallback<TState>
  | ClassifierAgentEntry<TState>
  | ClassifierRunEntry<TState>;

/**
 * Forensic record of a classifier run, surfaced on
 * `SupervisorReport.classifier` (Phase 7). Sibling of `report.ack` —
 * complete forensic detail regardless of what strip-merged into state.
 *
 * `intent` here is the FINAL intent dispatched (post-refine override).
 * `refined` indicates whether the refine hook changed something.
 * Original classifier output is captured on `raw` for debugging.
 */
export type ClassifierSnapshot = {
  /** Final intent dispatched (post-refine), or absent when refine returned END before any dispatch. */
  intent?: string;
  reasoning?: string;
  confidence?: number;
  /** True when refine returned a non-undefined value that overrode or augmented the classifier output. */
  refined: boolean;
  /** True when refine (or classifier-only mode) halted before any intent dispatched. */
  halted: boolean;
  /** Original classifier output (pre-refine) — preserved for debugging. */
  raw: ClassifierOutput;
  startedAt: string;
  endedAt: string;
  duration: number;
  usage: Usage;
  /**
   * Set when the classifier itself errored OR refine threw. Run is
   * aborted in either case — the supervisor terminates with this
   * error on `result.error`.
   */
  error?: AIError;
};
