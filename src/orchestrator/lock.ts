import type { CheckpointRecord } from "../contracts/orchestrator/checkpoint-store.contract";
import type { SummarizeConfig } from "../contracts/orchestrator/orchestrator-config.type";
import type { OrchestratorEngineContext } from "./engine-context.type";

/** Framework default for the compaction-lock wait, in ms (§3 / §12.3). */
export const DEFAULT_LOCK_MAX_WAIT = 30_000;

/** Poll interval while waiting on a held lock, in ms. */
const LOCK_POLL_INTERVAL = 100;

/**
 * Resolve the configured `summarize.lock.maxWait`, falling back to the
 * framework default. The callback form of `summarize` carries no lock
 * config, so it uses the default.
 */
function resolveMaxWait(ctx: OrchestratorEngineContext): number {
  const summarize = ctx.config.summarize;

  if (typeof summarize === "function" || summarize === undefined) {
    return DEFAULT_LOCK_MAX_WAIT;
  }

  return (summarize as SummarizeConfig).lock?.maxWait ?? DEFAULT_LOCK_MAX_WAIT;
}

/** Whether a checkpoint's lock is still held relative to `now`. */
function isLocked(record: CheckpointRecord, now: number): boolean {
  if (!record.lock_expires_at) {
    return false;
  }

  const expiresAt = Date.parse(record.lock_expires_at);

  return Number.isFinite(expiresAt) && expiresAt > now;
}

/**
 * Outcome of Phase 3. `waited` is true when the turn observed a held
 * lock and spent time waiting; `waitedMs` is how long. `failedOpen` is
 * true when the wait timed out and the turn proceeds without the lock
 * (orchestrator.md §3 / §12.3 — a stuck summarizer must never block a
 * session forever).
 */
export type LockOutcome = {
  waited: boolean;
  waitedMs: number;
  failedOpen: boolean;
};

/**
 * Phase 3 — lock check (orchestrator.md §3 / §4 Phase 3). The loaded
 * checkpoint may carry a compaction lock written by a prior turn's
 * Phase 7 (or by `command("compact")`). When the lock is still live,
 * wait up to `summarize.lock.maxWait` (default 30s), re-loading the
 * latest checkpoint each poll, then **fail open** — proceed without
 * the lock.
 *
 * Emits `orchestrator.lock.waiting` once, only when a held lock is
 * observed (§14.1 — "only when locked"). The dispatch then runs
 * against whatever state was written before the lock was taken (§3).
 *
 * A new session (`loaded === undefined`) is never locked, so this
 * returns immediately.
 */
export async function acquireLock<TState>(
  ctx: OrchestratorEngineContext<unknown, TState>,
  sessionId: string,
  loaded: CheckpointRecord | undefined,
): Promise<LockOutcome> {
  if (!loaded || !isLocked(loaded, Date.now())) {
    return { waited: false, waitedMs: 0, failedOpen: false };
  }

  const maxWait = resolveMaxWait(ctx as OrchestratorEngineContext);
  const startedAt = Date.now();

  ctx.emitter.emit("orchestrator.lock.waiting", { sessionId, waitedMs: 0 });

  let latest: CheckpointRecord | undefined = loaded;

  while (latest && isLocked(latest, Date.now())) {
    const waitedMs = Date.now() - startedAt;

    if (waitedMs >= maxWait) {
      return { waited: true, waitedMs, failedOpen: true };
    }

    await delay(Math.min(LOCK_POLL_INTERVAL, maxWait - waitedMs));

    latest = await ctx.checkpointStore.load(ctx.config.name, sessionId);
  }

  return { waited: true, waitedMs: Date.now() - startedAt, failedOpen: false };
}

/** Promise-based sleep used by the cooperative wait loop. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
