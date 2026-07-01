import type { AgentEventMap } from "../events/event-map.type";
import type { ExecutableContract } from "../executable.contract";
import type { AgentResult } from "../result/agent-result.type";
import type { StreamContract } from "../stream/stream.contract";
import type { AgentExecuteOptions, AgentResumeOptions } from "./agent-options.type";
import type { EvalOptions, EvalReport } from "./eval.type";

/**
 * Handler function for a single agent event. Takes the event's typed
 * payload; return value is ignored.
 */
export type AgentEventHandler<K extends keyof AgentEventMap> = (
  payload: AgentEventMap[K],
) => void;

/**
 * Contract for an AI agent — the core executable primitive.
 *
 * Supports a 3-tier event subscription model. All three layers fire in
 * order on every event: **factory → instance → per-call**. A listener
 * at any level can inspect the same event without the others needing
 * to know.
 *
 * - **Factory-level** — `ai.agent({ on: {...} })`. Fires on every run.
 * - **Instance-level** — `agent.on(event, handler)` / `agent.off(...)`.
 *   Imperative additions that persist across every `execute()`/`stream()`
 *   call on this instance. `on()` returns an unsubscribe function.
 * - **Per-call** — `agent.execute(input, { on: {...} })` or
 *   `agent.stream(input, { on: {...} })`. Scoped to that one run.
 *
 * @example
 * const myAgent = ai.agent({
 *   model,
 *   on: { "agent.starting": () => metrics.inc("agent.runs") },
 * });
 *
 * const unsubscribe = myAgent.on("agent.error", ({ error }) => logger.error(error));
 *
 * const result = await myAgent.execute("Summarize this", {
 *   output: z.object({ summary: z.string() }),
 *   on: { "agent.trip.completed": ({ trip }) => console.log(trip.duration) },
 * });
 *
 * unsubscribe();
 *
 * @example
 * // Stream tokens as they arrive
 * const stream = myAgent.stream("Write a poem");
 * for await (const event of stream) {
 *   if (event.type === "agent.trip.streaming") process.stdout.write(event.delta);
 * }
 * const result = await stream.result;
 */
export interface AgentContract<TOutput = unknown> extends ExecutableContract<
  string,
  AgentExecuteOptions<TOutput>,
  AgentResult<TOutput>
> {
  /**
   * Stable identifier for this agent. Always populated — if the
   * factory caller omitted `name`, a deterministic
   * `anon_<provider>_<model>[_<tool>+...]` fingerprint is synthesized
   * (same config → same name across restarts). Consumers that require
   * a *meaningful* name (workflow step, tool wrapper) should
   * additionally check `isAnonymous`.
   */
  readonly name: string;
  /**
   * `true` when the agent was constructed without an explicit name.
   * Workflow / tool boundaries reject anonymous agents at author time
   * so signature drift detection and tool routing stay honest.
   */
  readonly isAnonymous: boolean;
  /**
   * Optional short summary — surfaced to supervisor router prompts and
   * to `asTool()` wrappers. Mirrors whatever was set on
   * `AgentConfig.description` at factory time.
   */
  readonly description?: string;
  /**
   * Structural drift fingerprint of the agent definition — model +
   * provider + sorted tool names + maxTrips + output presence + version.
   * Stamped on every durable snapshot and compared on `resume()`; a
   * mismatch throws `AgentDriftError`. Always populated (computed at
   * factory time), independent of whether `durable` is configured.
   */
  readonly signature: string;
  /**
   * Stream execution events in real time.
   * Yields typed StreamEvent values and resolves result when done.
   */
  stream(
    input: string,
    options?: AgentExecuteOptions<TOutput>,
  ): StreamContract<AgentResult<TOutput>>;

  /**
   * Resume a durable run after a crash. Loads the snapshot persisted
   * under `runId` (requires `durable` on the config, or a global
   * `defaultSnapshotStore`), re-hydrates the completed trips + tool
   * calls + usage, and continues the trip loop from the next trip —
   * never re-issuing a completed trip's model call or re-invoking its
   * tools. A resume of an already-settled run re-returns the stored
   * result without running anything.
   *
   * Refuses to continue when the current definition has structurally
   * drifted from the snapshot (`AgentDriftError`), unless
   * `{ force: true }` is passed. Throws `AgentExecutionError` when no
   * store is configured or no snapshot exists for `runId`.
   *
   * @example
   * const result = await writer.execute("research X", { runId: "run-42" });
   * // ...process crashes mid-run...
   * const recovered = await writer.resume("run-42");
   */
  resume(
    runId: string,
    options?: AgentResumeOptions<TOutput>,
  ): Promise<AgentResult<TOutput>>;

  /**
   * Subscribe a handler to a single event name for the lifetime of
   * this agent instance. Returns an unsubscribe function; calling it
   * is equivalent to `off(event, handler)`.
   */
  on<K extends keyof AgentEventMap>(
    event: K,
    handler: AgentEventHandler<K>,
  ): () => void;

  /**
   * Remove a previously-subscribed handler. No-op when the handler was
   * never registered or was already removed.
   */
  off<K extends keyof AgentEventMap>(
    event: K,
    handler: AgentEventHandler<K>,
  ): void;

  /**
   * Run a suite of evaluation cases against this agent and return an
   * aggregate {@link EvalReport}. Each case runs through
   * `execute(input)`; the result is scored by the resolved scorers —
   * a per-case `scorers` override, else the suite `scorers`, else the
   * suite `judge` (LLM-as-judge). A case passes only when every scorer
   * passes and the agent did not error.
   *
   * Never throws on a case-level failure — failures surface on the
   * report (`report.passed`, per-case `passed`) and via the
   * `onFailure` callback. Throws at author time only when a case can
   * resolve neither a scorer nor a judge.
   *
   * @example
   * const report = await myAgent.eval({
   *   cases: [
   *     { name: "capital", input: "Capital of Egypt?", expected: "Cairo" },
   *   ],
   *   scorers: [ai.eval.exact()],
   * });
   *
   * expect(report.passed).toBe(true);
   *
   * @example
   * // LLM-as-judge
   * const report = await myAgent.eval({
   *   cases: [{ name: "tone", input: "Comfort an upset user." }],
   *   judge: { agent: judgeAgent, rubric: "Score 1.0 only if empathetic." },
   * });
   *
   * @typeParam TEval - Output type the eval cases/scorers are written
   *   against. Defaults to the agent's own `TOutput`, so normal calls
   *   stay fully typed. Exposed as a method-level generic (rather than
   *   pinned to the interface's `TOutput`) so that the `eval` surface —
   *   which references `TOutput` invariantly through the per-case
   *   `output` schema — does not make `AgentContract<TOutput>` itself
   *   invariant. That keeps a concretely-typed agent (e.g.
   *   `AgentContract<RouterOutput>`) assignable to an
   *   `AgentContract<unknown>` slot such as the supervisor's `router`,
   *   `intents`, and `classifier`.
   */
  eval<TEval = TOutput>(options: EvalOptions<TEval>): Promise<EvalReport<TEval>>;
}
