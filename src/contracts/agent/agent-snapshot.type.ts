import type { Message } from "../conversation-message.type";
import type { LLMTrip } from "../result/llm-trip.type";
import type { ToolCall } from "../result/tool-call.type";
import type { Usage } from "../result/usage.type";

/**
 * Lifecycle status of a durable agent run, recorded on the persisted
 * snapshot so `resume()` can decide whether a run is still in flight.
 *
 * - `"running"` — the trip loop is active; a resume is legitimate if
 *   the process crashed between trip boundaries.
 * - `"completed"` — the agent terminated successfully; resume is a
 *   no-op and re-returns the final result rebuilt from the snapshot.
 * - `"cancelled"` — aborted via `AbortSignal`; resume is allowed (the
 *   caller decides whether to retry).
 * - `"failed"` — terminated with an error; resume after the fix.
 */
export type AgentSnapshotStatus =
  | "running"
  | "completed"
  | "cancelled"
  | "failed";

/**
 * Persisted shape written to the configured {@link
 * import("../orchestrator/snapshot-store.contract").SnapshotStore} after
 * every trip settles. Exists so `agent.resume(runId)` can re-hydrate the
 * assembled conversation + completed trips + tool calls + running usage
 * and continue the trip loop from the next `tripIndex`.
 *
 * **Checkpoint granularity is per-trip.** The snapshot is written at the
 * end of `runTrip`, after every tool the trip requested has been
 * dispatched and its result message appended — the only point in the
 * loop where `messages`, `trips`, `toolCalls`, and `usage` are mutually
 * consistent. A crash mid-trip loses only that in-flight trip (never
 * checkpointed), which the resumed run re-issues cleanly.
 *
 * `signature` is a structural fingerprint covering model + provider +
 * sorted tool names + maxTrips + output presence + version (see
 * {@link import("../../agent/signature").computeAgentSignature}).
 * `resume()` compares it against the current agent's signature; a
 * mismatch throws `AgentDriftError` (bypassable with `{ force: true }`).
 *
 * Every field is JSON-serializable — `Message`, `LLMTrip`, `ToolCall`,
 * and `Usage` are the same plain-data shapes already persisted on
 * reports, so the snapshot round-trips through any `SnapshotStore`
 * backend (`memory`, `pg`, `redis`) verbatim.
 *
 * @example
 * const snapshot: AgentSnapshot | undefined = await store.load(runId);
 * if (snapshot?.status === "running") {
 *   await agent.resume(runId);
 * }
 */
export type AgentSnapshot = {
  /** The store key — stable across the whole run. */
  runId: string;
  /** Resolved agent name, for the resume error message + attribution. */
  agentName: string;
  /** Structural drift fingerprint (see `computeAgentSignature`). */
  signature: string;
  /** `AgentConfig.version` — metadata only, never compared. */
  version?: string;
  /** The original `execute(input)` value — needed to rebuild context. */
  input: string;
  /**
   * The resolved system-prompt text captured once on the first run, so
   * a resume skips `buildInitialMessages` (the messages array already
   * holds the system turn). Absent when the agent had no prompt.
   */
  systemPrompt?: string;
  /**
   * The wire-level JSON Schema sent to the model for structured output,
   * captured so resume re-issues continuation trips with the identical
   * response contract. Absent when the agent produced untyped output.
   */
  responseSchema?: Record<string, unknown>;
  /** Registry name of the resolved named prompt, when one was used. */
  promptName?: string;
  /** Registry version label paired with {@link AgentSnapshot.promptName}. */
  promptVersion?: string;
  /**
   * The live conversation array — assistant turns (with `toolCalls`)
   * plus tool-result turns — assembled across the persisted trips.
   * Re-hydrated verbatim so the next trip sees the full history.
   */
  messages: Message[];
  /**
   * Every settled trip so far. `trips.length` is the next `tripIndex`
   * the resumed loop starts at, so completed trips never re-run.
   */
  trips: LLMTrip[];
  /** Every settled tool dispatch (flat, each carrying its `tripIndex`). */
  toolCalls: ToolCall[];
  /** Running usage total across the persisted trips — never double-counted. */
  usage: Usage;
  status: AgentSnapshotStatus;
  startedAt: string;
  savedAt: string;
};
