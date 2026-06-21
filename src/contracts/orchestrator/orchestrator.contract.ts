import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ToolContract } from "../../tool/tool";
import type { OrchestratorResult } from "../result/orchestrator-result.type";
import type { StreamContract } from "../stream/stream.contract";
import type { SupervisorInput } from "../supervisor/supervisor-input.type";
import type { OrchestratorCommands } from "./orchestrator-commands.type";
import type {
  OrchestratorEvent,
  OrchestratorEventHandler,
  OrchestratorEventName,
} from "./orchestrator-event.type";
import type {
  OrchestratorExecuteOptions,
  OrchestratorResumeOptions,
} from "./orchestrator-execute-options.type";

/**
 * How a wrapped orchestrator scopes its session when invoked as a tool
 * (design §13.1).
 *
 * - `"fresh"` (default) — every tool invocation gets a brand-new
 *   `sessionId`; no continuity across calls. Safe default.
 * - `"shared"` — the wrapped orchestrator participates in the parent's
 *   session; the `sessionId` is supplied via the tool's `inputSchema`
 *   payload. Expert escape hatch for nested-conversation use cases.
 */
export type OrchestratorSessionScope = "fresh" | "shared";

/**
 * Context overrides for a specific session.
 *
 * @deprecated Obsolete v2 forward-declaration. The locked v1
 * orchestrator has no stateful session object and no `session()`
 * method — sessions are owned via a `sessionId` string passed per call
 * (`OrchestratorExecuteOptions.sessionId`, §18.1). Request-scoped
 * overrides are now `OrchestratorExecuteOptions.context`. Retained
 * unchanged for one minor for non-breaking compatibility; do not use in
 * new code.
 */
export type SessionContextOverrides = {
  [key: string]: unknown;
};

/**
 * Options accepted by `orchestrator.asTool()` (design §13). Mirrors
 * `SupervisorAsToolOptions` and adds `sessionScope` so the parent can
 * choose whether each tool call opens a fresh session or shares one.
 *
 * `inputSchema` types the tool's `input` payload — the orchestrator
 * receives the coerced payload as its `execute(input)` argument.
 */
export type OrchestratorAsToolOptions<TToolInput = string> = {
  name?: string;
  description?: string;
  inputSchema: StandardSchemaV1<TToolInput>;
  /** Session continuity for tool calls. Default `"fresh"`. */
  sessionScope?: OrchestratorSessionScope;
};

/**
 * Runtime handle returned by `ai.orchestrator(config)` (design §15.3) —
 * a session-state manager wrapped around a supervisor. The v1 capstone
 * of the 4-primitive ladder (agent → workflow → supervisor →
 * orchestrator).
 *
 * The session is owned via `sessionId` passed per call (§18.1) — there
 * is no stateful session object and no implicit "current session".
 * Every method names the session it acts on. `execute` and `stream`
 * run one turn; `resume` continues an interrupted turn from its
 * persisted checkpoint; `command` invokes a typed built-in (e.g.
 * `compact`); `asTool` exposes the orchestrator to an outer agent.
 *
 * Implements the 3-tier event subscription model (definition →
 * instance → per-call). Child `supervisor.*` / `agent.*` events bubble
 * up unmodified under their own identity (§14.2).
 *
 * @example
 * const supportBot = ai.orchestrator<SessionState>({
 *   name: "refund-support",
 *   intents: { classify, lookup, process, compose },
 *   route: (ctx) => (ctx.iteration === 0 ? "classify" : END),
 * });
 *
 * const result = await supportBot.execute(message, { sessionId, history });
 * if (result.report.status === "awaiting-input") {
 *   // session continues — wait for the next user turn
 * }
 */
export interface OrchestratorContract<TOutput = unknown, TState = TOutput> {
  /** Stable identifier — mirrors the config's `name`. */
  readonly name: string;
  /** Structural fingerprint of the orchestrator definition (§10.1). */
  readonly signature: string;
  /** Dev-curated version string, or `undefined` when none was declared. */
  readonly version: string | undefined;

  /**
   * Run one turn end-to-end against the named session. Returns the
   * per-turn `OrchestratorResult`. Never throws on runtime failure —
   * errors surface via `result.error`; drift / config misuse throw.
   */
  execute(
    input: SupervisorInput,
    options: OrchestratorExecuteOptions<TState>,
  ): Promise<OrchestratorResult<TOutput>>;

  /**
   * Stream the turn's lifecycle events in real time. `result` resolves
   * to the same value `execute()` would produce; child agent/supervisor
   * streaming bubbles up under its own namespace.
   */
  stream(
    input: SupervisorInput,
    options: OrchestratorExecuteOptions<TState>,
  ): StreamContract<OrchestratorResult<TOutput>, OrchestratorEvent>;

  /**
   * Resume an interrupted turn from its persisted checkpoint. Returns
   * `null` when there is nothing to resume for the session. Throws
   * `OrchestratorDriftError` on signature drift unless `{ force: true }`.
   */
  resume(
    sessionId: string,
    options?: OrchestratorResumeOptions,
  ): Promise<OrchestratorResult<TOutput> | null>;

  /**
   * Invoke a typed built-in command (design §11). v1 ships `compact`;
   * user commands attach via module augmentation of
   * `OrchestratorCommands`.
   */
  command<K extends keyof OrchestratorCommands>(
    name: K,
    args: OrchestratorCommands[K]["args"],
  ): Promise<OrchestratorCommands[K]["result"]>;

  /**
   * Wrap this orchestrator as a `ToolContract` so an outer agent can
   * invoke it inside its tool-call loop. `sessionScope` controls
   * session continuity across calls (§13.1).
   */
  asTool<TToolInput = string>(
    options: OrchestratorAsToolOptions<TToolInput>,
  ): ToolContract<TToolInput, TOutput>;

  /**
   * Subscribe an instance-level handler — tier 2 of the 3-tier model.
   * Returns an unsubscribe function equivalent to `off(event, handler)`.
   */
  on<K extends OrchestratorEventName>(
    event: K,
    handler: OrchestratorEventHandler<K>,
  ): () => void;

  /**
   * Remove a previously-subscribed instance-level handler. No-op when
   * the handler was never registered or already removed.
   */
  off<K extends OrchestratorEventName>(
    event: K,
    handler: OrchestratorEventHandler<K>,
  ): void;
}
