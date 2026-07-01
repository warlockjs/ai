import { resolveDefaultSnapshotStore } from "../config";
import type { SnapshotStore } from "../contracts/orchestrator/snapshot-store.contract";
import type { PlannerResumeOptions } from "../contracts/planner/planner-execute-options.type";
import type { PlannerPlan } from "../contracts/planner/planner-plan.type";
import type { PlannerStepSnapshot } from "../contracts/planner/planner-result.type";
import type {
  PlannerSnapshot,
  PlannerSnapshotStatus,
} from "../contracts/planner/planner-snapshot.type";
import type { BaseReport } from "../contracts/result/base-report.type";
import type { Usage } from "../contracts/result/usage.type";
import { PlannerDriftError, PlannerFailedError } from "../errors";

/**
 * The planner's `durable` config, narrowed to the fields the snapshot
 * helpers read.
 */
export type PlannerDurableConfig = {
  store?: SnapshotStore<PlannerSnapshot>;
  deleteOnComplete?: boolean;
};

/**
 * Resolve the effective {@link SnapshotStore}: the planner's own
 * `durable.store` wins; absent that, fall back to the global default set
 * via `ai.config({ defaultSnapshotStore })`.
 *
 * The global default is typed for the supervisor snapshot shape, but
 * every store impl keys purely by `runId` and round-trips whatever
 * envelope it is handed — so it serves a `PlannerSnapshot` just as well.
 * The cast re-tags the shape at this single boundary (Option B); the
 * planner only ever hands it a `PlannerSnapshot`.
 */
function resolveSnapshotStore(
  durable: PlannerDurableConfig | undefined,
): SnapshotStore<PlannerSnapshot> | undefined {
  return (
    durable?.store ??
    (resolveDefaultSnapshotStore() as SnapshotStore<PlannerSnapshot> | undefined)
  );
}

export type PersistPlannerParams = {
  durable: PlannerDurableConfig | undefined;
  runId: string;
  plannerName: string;
  signature: string;
  version?: string;
  goal: string;
  plan: PlannerPlan;
  executedSteps: PlannerStepSnapshot[];
  usage: Usage;
  children: BaseReport[];
  replanCount: number;
  status: PlannerSnapshotStatus;
  startedAt: string;
};

export type PersistOutcome = { ok: true } | { ok: false; error: unknown };

/**
 * Write the current run state to the resolved snapshot store. No-op
 * (returns `{ ok: true }`) when neither `durable.store` nor the global
 * `defaultSnapshotStore` is configured — the common non-durable path.
 * Failures are returned as `{ ok: false }` rather than thrown so the
 * engine can surface them via logs without aborting the run.
 */
export async function persistPlannerSnapshot(
  params: PersistPlannerParams,
): Promise<PersistOutcome> {
  const store = resolveSnapshotStore(params.durable);

  if (!store) {
    return { ok: true };
  }

  const snapshot: PlannerSnapshot = {
    runId: params.runId,
    plannerName: params.plannerName,
    signature: params.signature,
    version: params.version,
    goal: params.goal,
    plan: params.plan,
    executedSteps: params.executedSteps,
    usage: params.usage,
    children: params.children,
    replanCount: params.replanCount,
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
 * `durable.deleteOnComplete` is set. Never throws. No-op (ok) when no
 * store is configured.
 */
export async function deletePlannerSnapshot(params: {
  durable: PlannerDurableConfig | undefined;
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
 * Throws `PlannerFailedError` when no store is configured or when the run
 * is missing; throws `PlannerDriftError` when the stored signature
 * doesn't match the current definition (unless `force` is set).
 */
export async function loadPlannerSnapshotForResume(params: {
  durable: PlannerDurableConfig | undefined;
  plannerName: string;
  signature: string;
  runId: string;
  options?: PlannerResumeOptions<unknown>;
}): Promise<PlannerSnapshot> {
  const store = resolveSnapshotStore(params.durable);

  if (!store) {
    throw new PlannerFailedError(
      `ai.planner("${params.plannerName}"): no durable store configured — set \`durable: { store }\` on the config or call \`ai.config({ defaultSnapshotStore })\` at boot before calling resume()`,
      { context: { runId: params.runId } },
    );
  }

  const snapshot = (await store.load(params.runId)) ?? null;

  if (!snapshot) {
    throw new PlannerFailedError(
      `ai.planner("${params.plannerName}"): no snapshot for runId "${params.runId}"`,
      { context: { runId: params.runId } },
    );
  }

  if (!params.options?.force && snapshot.signature !== params.signature) {
    throw new PlannerDriftError(
      `ai.planner("${params.plannerName}") signature drift on resume`,
      {
        savedSignature: snapshot.signature,
        currentSignature: params.signature,
        runId: params.runId,
      },
    );
  }

  return snapshot;
}
