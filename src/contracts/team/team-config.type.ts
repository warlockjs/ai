import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { AgentContract } from "../agent/agent.contract";
import type { EvaluateContext, EvaluateResult } from "../supervisor/evaluate-context.type";
import type { RouterEntry } from "../supervisor/router-entry.type";
import type { SupervisorConfig, SupervisorEventHandlers } from "../supervisor/supervisor-config.type";
import type { FlowObserveOption } from "../../observe/resolve-observers";
import type { SnapshotStore } from "../orchestrator/snapshot-store.contract";
import type { SystemPromptContract } from "../system-prompt.contract";
import type { WorkflowInstance } from "../workflow/workflow.contract";

/**
 * A role member — an agent or a workflow. The same shorthand the
 * supervisor accepts on each `intents` value, narrowed to the two
 * dispatchable unit shapes `team()` forwards verbatim. (Callback /
 * full-entry intent shapes still work when forwarded — this alias is
 * the documented, autocomplete-friendly subset for the common case.)
 */
export type TeamMemberValue =
  | AgentContract<unknown>
  | WorkflowInstance<unknown, unknown>;

/**
 * The built-in quality-gate strategies. Each desugars to a concrete
 * {@link SupervisorConfig.evaluate} callback — no new loop or
 * termination code; both lean entirely on the already-shipped
 * {@link EvaluateResult} semantics (`satisfied` terminates,
 * `reassignTo` re-dispatches the fixer, `feedback` threads forward).
 *
 * - `"quality"` — review-then-fix loop. After members settle, read the
 *   reviewer's verdict slice (`state.approved` by default); if not
 *   approved, `reassignTo` the fixer with the reviewer feedback
 *   (`state.notes`) threaded forward. Terminates on approval.
 * - `"verify"` — test-then-fix loop. Same shape but keyed on the
 *   tester's pass/fail slice (`state.passed` by default) instead of a
 *   subjective reviewer score.
 */
export type TeamGate = "quality" | "verify";

/**
 * Fully-custom gate — an escape hatch identical to
 * {@link SupervisorConfig.evaluate}. Supplying a function instead of a
 * {@link TeamGate} string opts out of the sugar entirely while keeping
 * the rest of `team()`'s wiring. Forwarded straight through as
 * `evaluate` with zero wrapping.
 */
export type TeamGateFn<TState> = (
  ctx: EvaluateContext<TState>,
) => EvaluateResult | Promise<EvaluateResult>;

/**
 * Config for `ai.team(config)` — thin, transparent sugar over
 * {@link SupervisorConfig}. `team()` builds a `SupervisorConfig` from
 * these fields and calls `supervisor(...)`, returning the **unchanged**
 * `SupervisorContract<TOutput>`. It owns no loop: the manager becomes
 * `route`/`router`, the members become `intents`, and the gate becomes
 * `evaluate`. Everything else passes through 1:1.
 *
 * @example
 * const codeTeam = ai.team({
 *   name: "code-team",
 *   goal: "Ship a tested module that passes review.",
 *   manager: techLeadRouter,
 *   members: { builder, reviewer, fixer },
 *   gate: "quality",
 *   output: v.object({ code: v.string() }),
 *   maxIterations: 6,
 * });
 */
export type TeamConfig<
  TOutput = unknown,
  TState = TOutput,
  TMembers extends Record<string, TeamMemberValue> = Record<string, TeamMemberValue>,
> = {
  /** Stable identifier — forwarded verbatim to `SupervisorConfig.name`. */
  name: string;

  /** Optional dev-curated version string — forwarded to `SupervisorConfig.version`. */
  version?: string;

  /**
   * The manager. Drives dispatch each iteration. Two forms:
   * - an `AgentContract` / `RouterEntry` → becomes `SupervisorConfig.router`
   *   (LLM-driven manager).
   * - `{ route }` → becomes `SupervisorConfig.route` (deterministic manager).
   * Exactly one is forwarded; mutually exclusive (mirrors the
   * supervisor's own `router` XOR `route` rule).
   */
  manager:
    | AgentContract<unknown>
    | RouterEntry<TState>
    | { route: NonNullable<SupervisorConfig<TOutput, TState>["route"]> };

  /**
   * Role members keyed by role name (e.g. `builder`, `reviewer`,
   * `tester`, `fixer`). Forwarded verbatim as `SupervisorConfig.intents`.
   * The keys are the role names the manager routes to AND the keys
   * `ctx.intents.<role>` exposes (escape hatch preserved).
   */
  members: TMembers;

  /**
   * The quality gate. A {@link TeamGate} string selects a pre-built
   * `evaluate` strategy; a function is forwarded straight to
   * `SupervisorConfig.evaluate` (full escape hatch). Required — a team
   * without a gate is just a supervisor.
   */
  gate: TeamGate | TeamGateFn<TState>;

  /**
   * Role-name mapping for the built-in string gates. Only consulted
   * when `gate` is a {@link TeamGate} string. Defaults:
   * `{ reviewer: "reviewer", fixer: "fixer", tester: "tester" }`.
   * Override when your `members` keys differ from the canonical role
   * names.
   */
  roles?: {
    reviewer?: keyof TMembers & string;
    fixer?: keyof TMembers & string;
    tester?: keyof TMembers & string;
  };

  /**
   * State key the gate reads to decide satisfaction. Defaults to
   * `"approved"` for `gate: "quality"` and `"passed"` for
   * `gate: "verify"`. The named member's `output` schema must write a
   * boolean into this key.
   */
  gateKey?: string;

  // ---- Pass-through to SupervisorConfig (unchanged semantics) ----

  /** Natural-language objective — forwarded verbatim to `SupervisorConfig.goal`. */
  goal?: string | SystemPromptContract;

  /** Final-state schema — forwarded verbatim to `SupervisorConfig.output`. */
  output?: StandardSchemaV1<TOutput>;

  /** Initial state seed — forwarded verbatim to `SupervisorConfig.state`. */
  state?: TState;

  /** Hard iteration cap — forwarded verbatim; defaults to the supervisor's `10`. */
  maxIterations?: number;

  /** Durable snapshot store — forwarded verbatim to `SupervisorConfig.snapshotStore`. */
  snapshotStore?: SnapshotStore;

  /** Definition-level event handlers — forwarded verbatim to `SupervisorConfig.on`. */
  on?: SupervisorEventHandlers;

  /**
   * Observability for this team — forwarded verbatim to
   * `SupervisorConfig.observe`, so the underlying supervisor routes its
   * completed report through the same generic `Observer` seam every
   * other flow uses. Additive and gated; see `SupervisorConfig.observe`
   * for the value semantics (`true` / `false` / a flow-local `Observer`).
   */
  observe?: FlowObserveOption;
};
