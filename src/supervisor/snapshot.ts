import { resolveDefaultSnapshotStore } from "../config";
import type { IterationSnapshot } from "../contracts/supervisor/iteration-snapshot.type";
import type { SupervisorConfig } from "../contracts/supervisor/supervisor-config.type";
import type { SupervisorResumeOptions } from "../contracts/supervisor/supervisor-execute-options.type";
import type { SupervisorInput } from "../contracts/supervisor/supervisor-input.type";
import type {
  SupervisorSnapshot,
  SupervisorSnapshotStatus,
} from "../contracts/supervisor/supervisor-snapshot.type";
import { SupervisorDriftError, SupervisorFailedError } from "../errors";

/**
 * Resolve the effective {@link SnapshotStore}: the supervisor's own
 * `snapshotStore` field wins; absent that, fall back to the global
 * default set via `ai.config({ defaultSnapshotStore })`.
 */
function resolveSnapshotStore(config: SupervisorConfig<unknown>) {
  return config.snapshotStore ?? resolveDefaultSnapshotStore();
}

export type PersistParams = {
  config: SupervisorConfig<unknown>;
  signature: string;
  runId: string;
  input: SupervisorInput;
  startedAt: string;
  iteration: number;
  snapshots: IterationSnapshot[];
  status: SupervisorSnapshotStatus;
};

export type PersistOutcome = { ok: true } | { ok: false; error: unknown };

/**
 * Write the current run state to the resolved snapshot store. No-op
 * (ok) when neither the supervisor's `snapshotStore` nor the global
 * `defaultStore` is configured. Failures are returned as
 * `{ ok: false }` rather than thrown so the engine can surface them
 * via events/logs without aborting the run — callers decide whether
 * a failed checkpoint is fatal.
 */
export async function persistSupervisorSnapshot(
  params: PersistParams,
): Promise<PersistOutcome> {
  const store = resolveSnapshotStore(params.config);

  if (!store) {
    return { ok: true };
  }

  const snapshot: SupervisorSnapshot = {
    runId: params.runId,
    supervisorName: params.config.name,
    signature: params.signature,
    input: params.input,
    iteration: params.iteration,
    snapshots: params.snapshots,
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
 * Load a persisted snapshot for `resume()` and run the drift check.
 * Throws `SupervisorFailedError` when no store is configured or when
 * the run is missing; throws `SupervisorDriftError` when the stored
 * signature doesn't match the current definition (unless `force` is
 * set).
 */
export async function loadSnapshotForResume(params: {
  config: SupervisorConfig<unknown>;
  signature: string;
  runId: string;
  options?: SupervisorResumeOptions;
}): Promise<SupervisorSnapshot> {
  const store = resolveSnapshotStore(params.config);

  if (!store) {
    throw new SupervisorFailedError(
      `supervisor "${params.config.name}" has no store configured — set \`snapshotStore\` on the config or call \`ai.config({ defaultSnapshotStore })\` at boot before calling resume()`,
      { context: { runId: params.runId } },
    );
  }

  const snapshot = (await store.load(params.runId)) ?? null;

  if (!snapshot) {
    throw new SupervisorFailedError(
      `supervisor "${params.config.name}": no snapshot for runId "${params.runId}"`,
      { context: { runId: params.runId } },
    );
  }

  if (!params.options?.force && snapshot.signature !== params.signature) {
    throw new SupervisorDriftError(
      `supervisor "${params.config.name}" signature drift on resume`,
      {
        savedSignature: snapshot.signature,
        currentSignature: params.signature,
        runId: params.runId,
      },
    );
  }

  return snapshot;
}
