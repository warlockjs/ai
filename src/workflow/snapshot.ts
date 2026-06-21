import { resolveDefaultSnapshotStore } from "../config";
import type { SnapshotStore } from "../contracts/orchestrator/snapshot-store.contract";
import type { StepSnapshot } from "../contracts/result/step-result.type";
import type { WorkflowSnapshot } from "../contracts/workflow/workflow-snapshot.type";
import type {
  WorkflowDefinition,
  WorkflowResumeOptions,
} from "../contracts/workflow/workflow.contract";
import { WorkflowDriftError, WorkflowError } from "../errors";

/**
 * Resolve the effective {@link SnapshotStore}: the workflow's own
 * `snapshotStore` field wins; absent that, fall back to the global
 * default set via `ai.config({ defaultSnapshotStore })`.
 *
 * The global default is typed for the supervisor snapshot shape, but
 * every store impl keys purely by `runId` and round-trips whatever
 * envelope it is handed — so it serves a `WorkflowSnapshot` just as
 * well. The cast re-tags the shape at this single boundary; the
 * workflow only ever hands it a `WorkflowSnapshot`.
 */
function resolveSnapshotStore<T>(
  definition: WorkflowDefinition<any, T, any, any>,
): SnapshotStore<WorkflowSnapshot> | undefined {
  return (
    definition.snapshotStore ??
    (resolveDefaultSnapshotStore() as SnapshotStore<WorkflowSnapshot> | undefined)
  );
}

export type PersistParams<T> = {
  definition: WorkflowDefinition<any, T, any, any>;
  signature: string;
  runId: string;
  startedAt: string;
  input: unknown;
  state: Record<string, unknown>;
  steps: Record<string, StepSnapshot>;
  next: string | null;
  status: WorkflowSnapshot["status"];
};

export type PersistOutcome = { ok: true } | { ok: false; error: unknown };

/**
 * Write the current run's state to the configured `KVStore`. Returns
 * an outcome object instead of throwing so the engine can surface
 * persistence failures via events + logs without aborting the run.
 * Callers decide whether a failed checkpoint is fatal.
 *
 * No-op (returns `{ ok: true }`) when the workflow has no store
 * configured — the common in-memory test case.
 */
export async function persistSnapshot<T>(
  params: PersistParams<T>,
): Promise<PersistOutcome> {
  const store = resolveSnapshotStore(params.definition);

  if (!store) return { ok: true };

  const snapshot: WorkflowSnapshot = {
    runId: params.runId,
    workflowName: params.definition.name,
    signature: params.signature,
    version: params.definition.version,
    input: params.input,
    state: { ...params.state },
    steps: { ...params.steps },
    next: params.next,
    status: params.status,
    startedAt: params.startedAt,
    savedAt: new Date().toISOString(),
  };

  try {
    await store.save(snapshot);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err };
  }
}

/**
 * Load a prior run's snapshot from the store and run the drift
 * check. Throws `WorkflowError` when no snapshot exists, and
 * `WorkflowDriftError` when the stored signature doesn't match the
 * current definition (unless `force` is set).
 */
export async function loadSnapshotForResume<T>(params: {
  definition: WorkflowDefinition<any, T, any, any>;
  signature: string;
  runId: string;
  options?: WorkflowResumeOptions;
}): Promise<WorkflowSnapshot> {
  const store = resolveSnapshotStore(params.definition);

  if (!store) {
    throw new WorkflowError(
      `workflow "${params.definition.name}" has no store configured — set \`snapshotStore\` on the definition or call \`ai.config({ defaultSnapshotStore })\` at boot before calling resume()`,
    );
  }

  const snap = (await store.load(params.runId)) ?? null;

  if (!snap) {
    throw new WorkflowError(
      `workflow "${params.definition.name}": no snapshot for runId "${params.runId}"`,
    );
  }

  if (!params.options?.force && snap.signature !== params.signature) {
    throw new WorkflowDriftError(
      `workflow "${params.definition.name}" signature drift on resume`,
      {
        savedSignature: snap.signature,
        currentSignature: params.signature,
        runId: params.runId,
      },
    );
  }

  return snap;
}
