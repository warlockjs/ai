import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ToolContract } from "../../tool/tool";
import type { SupervisorEventMap } from "../events/event-map.type";
import type { ExecutableContract } from "../executable.contract";
import type { SupervisorResult } from "../result/supervisor-result.type";
import type { StreamContract } from "../stream/stream.contract";
import type { SupervisorEventHandler } from "./supervisor-config.type";
import type {
  SupervisorExecuteOptions,
  SupervisorResumeOptions,
} from "./supervisor-execute-options.type";
import type { SupervisorInput } from "./supervisor-input.type";
import type { SupervisorStreamEvent } from "./supervisor-stream-event.type";

/**
 * Options accepted by `supervisor.asTool()`, mirroring
 * `workflow.asTool()` / `agent.asTool()`. Exposes the supervisor as
 * a tool an outer agent can invoke inside its tool-call loop.
 *
 * `inputSchema` types the tool's `input` payload — the supervisor
 * receives the result of coercing the payload into a string (via
 * the same `stringifyInput` helper the other primitives use) as its
 * `execute(input)` argument.
 */
export type SupervisorAsToolOptions<TToolInput> = {
  name?: string;
  description?: string;
  inputSchema: StandardSchemaV1<TToolInput>;
};

/**
 * Runtime handle returned by `ai.supervisor(config)`. Third
 * implementer of `ExecutableContract` alongside `AgentContract` and
 * `WorkflowInstance`, so orchestrators and nested supervisors can
 * dispatch any primitive through the same uniform surface.
 *
 * Implements the 3-tier event subscription model (definition →
 * instance → per-call), with events fired in that order on every
 * emission. See `SupervisorEventMap` for the full surface.
 *
 * @example
 * const support = ai.supervisor({
 *   name: "customer-support",
 *   router: routerAgent,
 *   intents: { triage, resolver },
 *   output: z.object({ response: z.string() }),
 * });
 *
 * // Fire-and-forget — await the typed result
 * const { data, report, usage, error } = await support.execute(ticket);
 *
 * // Or stream every lifecycle event in real time
 * const stream = support.stream(ticket);
 * stream.on({
 *   "supervisor.router.decided": ({ next }) => console.log("→", next),
 *   "supervisor.agent.streaming": ({ intent, delta }) =>
 *     process.stdout.write(`[${intent}] ${delta}`),
 * });
 * const result = await stream.result;
 *
 * // Resume a crashed run from the persisted snapshot
 * const recovered = await support.resume("support-run-42");
 *
 * // Expose the supervisor as a tool for an outer agent
 * const tool = support.asTool({
 *   name: "handle_support_ticket",
 *   description: "Processes a customer support ticket end-to-end.",
 *   inputSchema: z.object({ ticket: z.string() }),
 * });
 */
export interface SupervisorContract<TOutput = unknown> extends ExecutableContract<
  SupervisorInput,
  SupervisorExecuteOptions,
  SupervisorResult<TOutput>
> {
  /** Stable identifier — mirrors the config's `name`. */
  readonly name: string;

  /**
   * Mirrors {@link SupervisorConfig.inputSchema} when set — lets the
   * agent tool-collection path auto-adapt this supervisor into a
   * `ToolContract` (manifest derived from name + this schema) when it
   * appears in `tools: []` without `.asTool()`.
   */
  readonly inputSchema?: StandardSchemaV1<SupervisorInput>;

  /**
   * Structural fingerprint of the supervisor definition — agent
   * keys + their resolved descriptions + router identity (if set) +
   * whether `route` was configured. Persisted on every snapshot so
   * `resume()` can detect drift.
   */
  readonly signature: string;

  /**
   * Run the supervisor end-to-end. Returns the uniform `{ data,
   * report, usage, error }` shape. Never throws on runtime failure —
   * errors surface via `result.error`. Authoring-time misconfig
   * throws at factory call, not here.
   */
  execute(
    input: SupervisorInput,
    options?: SupervisorExecuteOptions,
  ): Promise<SupervisorResult<TOutput>>;

  /**
   * Stream every lifecycle event in real time. Returns a
   * `StreamContract` whose `result` resolves to the same value
   * `execute()` would produce. Child agent streaming bubbles up as
   * `supervisor.agent.streaming` — UI consumers can render per-
   * agent tokens with zero extra wiring.
   */
  stream(
    input: SupervisorInput,
    options?: SupervisorExecuteOptions,
  ): StreamContract<SupervisorResult<TOutput>, SupervisorStreamEvent>;

  /**
   * Resume a supervisor run from its persisted snapshot. Requires
   * `store` to have been configured on the supervisor. Throws
   * `SupervisorDriftError` when the current definition's signature
   * doesn't match the snapshot's, unless `{ force: true }` is set.
   *
   * Idempotency across side-effectful agents is the caller's
   * responsibility — same contract as `workflow.resume()`.
   */
  resume(runId: string, options?: SupervisorResumeOptions): Promise<SupervisorResult<TOutput>>;

  /**
   * Subscribe an instance-level handler — tier 2 of the 3-tier
   * model. Fires on every run of this supervisor instance, between
   * definition-level and per-call handlers. Returns an unsubscribe
   * function equivalent to `off(event, handler)`.
   */
  on<K extends keyof SupervisorEventMap>(event: K, handler: SupervisorEventHandler<K>): () => void;

  /**
   * Remove a previously-subscribed instance-level handler. No-op
   * when the handler was never registered or already removed.
   */
  off<K extends keyof SupervisorEventMap>(event: K, handler: SupervisorEventHandler<K>): void;

  /**
   * Wrap this supervisor as a `ToolContract` so an outer agent can
   * invoke it inside its tool-call loop. The tool calls
   * `supervisor.execute(input)` internally; supervisor failures
   * surface as `ToolExecutionError` with `cause` set to the original
   * typed error.
   */
  asTool<TToolInput = string>(
    options: SupervisorAsToolOptions<TToolInput>,
  ): ToolContract<TToolInput, TOutput>;
}
