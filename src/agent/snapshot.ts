import { resolveDefaultSnapshotStore } from "../config";
import type {
  AgentResumeOptions,
} from "../contracts/agent/agent-options.type";
import type {
  AgentSnapshot,
  AgentSnapshotStatus,
} from "../contracts/agent/agent-snapshot.type";
import type { SnapshotStore } from "../contracts/orchestrator/snapshot-store.contract";
import type { Message } from "../contracts/conversation-message.type";
import type { LLMTrip } from "../contracts/result/llm-trip.type";
import type { ToolCall } from "../contracts/result/tool-call.type";
import type { Usage } from "../contracts/result/usage.type";
import { AgentDriftError, AgentExecutionError } from "../errors";

/**
 * The agent's `durable` config, narrowed to the fields the snapshot
 * helpers read. Kept minimal so this module doesn't depend on the full
 * resolved-config shape.
 */
export type AgentDurableConfig = {
  store?: SnapshotStore<AgentSnapshot>;
  deleteOnComplete?: boolean;
};

/**
 * Resolve the effective {@link SnapshotStore}: the agent's own
 * `durable.store` wins; absent that, fall back to the global default
 * set via `ai.config({ defaultSnapshotStore })`.
 *
 * The global default is typed for the supervisor snapshot shape, but
 * every store impl keys purely by `runId` and round-trips whatever
 * envelope it is handed — so it serves an `AgentSnapshot` just as well.
 * The cast re-tags the shape at this single boundary (Option B); the
 * agent only ever hands it an `AgentSnapshot`.
 */
function resolveSnapshotStore(
  durable: AgentDurableConfig | undefined,
): SnapshotStore<AgentSnapshot> | undefined {
  return (
    durable?.store ??
    (resolveDefaultSnapshotStore() as SnapshotStore<AgentSnapshot> | undefined)
  );
}

export type PersistAgentParams = {
  durable: AgentDurableConfig | undefined;
  runId: string;
  agentName: string;
  signature: string;
  version?: string;
  input: string;
  systemPrompt?: string;
  responseSchema?: Record<string, unknown>;
  promptName?: string;
  promptVersion?: string;
  messages: Message[];
  trips: LLMTrip[];
  toolCalls: ToolCall[];
  usage: Usage;
  status: AgentSnapshotStatus;
  startedAt: string;
};

export type PersistOutcome = { ok: true } | { ok: false; error: unknown };

/**
 * Write the current run state to the resolved snapshot store. No-op
 * (returns `{ ok: true }`) when neither `durable.store` nor the global
 * `defaultSnapshotStore` is configured — the common non-durable path.
 * Failures are returned as `{ ok: false }` rather than thrown so the
 * engine can surface them via logs without aborting the run — a failed
 * checkpoint loses resume-ability from that point but never breaks an
 * otherwise-healthy run.
 */
export async function persistAgentSnapshot(
  params: PersistAgentParams,
): Promise<PersistOutcome> {
  const store = resolveSnapshotStore(params.durable);

  if (!store) {
    return { ok: true };
  }

  const snapshot: AgentSnapshot = {
    runId: params.runId,
    agentName: params.agentName,
    signature: params.signature,
    version: params.version,
    input: params.input,
    systemPrompt: params.systemPrompt,
    responseSchema: params.responseSchema,
    promptName: params.promptName,
    promptVersion: params.promptVersion,
    messages: params.messages,
    trips: params.trips,
    toolCalls: params.toolCalls,
    usage: params.usage,
    status: params.status,
    startedAt: params.startedAt,
    savedAt: new Date().toISOString(),
  };

  try {
    await store.save(snapshot);

    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Delete a persisted snapshot — used after a successful run when
 * `durable.deleteOnComplete` is set. Never throws: a failed delete is
 * surfaced as `{ ok: false }` and the engine logs it. No-op (ok) when no
 * store is configured.
 */
export async function deleteAgentSnapshot(params: {
  durable: AgentDurableConfig | undefined;
  runId: string;
}): Promise<PersistOutcome> {
  const store = resolveSnapshotStore(params.durable);

  if (!store) {
    return { ok: true };
  }

  try {
    await store.delete(params.runId);

    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Load a persisted snapshot for `resume()` and run the drift check.
 * Throws `AgentExecutionError` when no store is configured or when the
 * run is missing; throws `AgentDriftError` when the stored signature
 * doesn't match the current definition (unless `force` is set).
 */
export async function loadAgentSnapshotForResume(params: {
  durable: AgentDurableConfig | undefined;
  agentName: string;
  signature: string;
  runId: string;
  options?: AgentResumeOptions<unknown>;
}): Promise<AgentSnapshot> {
  const store = resolveSnapshotStore(params.durable);

  if (!store) {
    throw new AgentExecutionError(
      `agent "${params.agentName}" has no durable store configured — set \`durable: { store }\` on the config or call \`ai.config({ defaultSnapshotStore })\` at boot before calling resume()`,
      { context: { runId: params.runId } },
    );
  }

  const snapshot = (await store.load(params.runId)) ?? null;

  if (!snapshot) {
    throw new AgentExecutionError(
      `agent "${params.agentName}": no snapshot for runId "${params.runId}"`,
      { context: { runId: params.runId } },
    );
  }

  if (!params.options?.force && snapshot.signature !== params.signature) {
    throw new AgentDriftError(
      `agent "${params.agentName}" signature drift on resume`,
      {
        savedSignature: snapshot.signature,
        currentSignature: params.signature,
        runId: params.runId,
      },
    );
  }

  return snapshot;
}
