import type { SessionLock } from "../contracts/orchestrator/session-lock.contract";

/**
 * Reason an aborted lock-wait rejects with — the signal's `reason` when
 * one was supplied to `controller.abort(reason)`, else a generic error.
 */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("session lock wait aborted");
}

/**
 * Framework-default in-process {@link SessionLock} — a per-key promise-
 * chain mutex. It holds one tail promise per session key; each acquirer
 * waits on the previous holder's release, then installs its own tail.
 * Keyed by `sessionId`, so different sessions never contend. The wait is
 * abortable, so a cancelled caller never deadlocks behind a stuck
 * predecessor (the deadlock-on-cancel trap).
 *
 * In-process only: serializes same-session turns within ONE process.
 * Supply a distributed {@link SessionLock} for multi-process deployments.
 */
export function inProcessSessionLock(): SessionLock {
  const tails = new Map<string, Promise<void>>();

  return {
    async withLock<T>(
      key: string,
      fn: () => Promise<T>,
      options?: { signal?: AbortSignal },
    ): Promise<T> {
      const existing = tails.get(key);
      const prev = existing ?? Promise.resolve();

      // The caller's signal aborts a genuine WAIT only. When the lock is
      // free (no existing tail) we acquire immediately and let `fn` own
      // cancellation — so a pre-aborted signal never pre-empts graceful
      // in-flight handling (e.g. the orchestrator emitting turn.cancelled).
      const waitSignal = existing ? options?.signal : undefined;

      let release!: () => void;
      const held = new Promise<void>(resolve => {
        release = resolve;
      });

      // Successors queue behind OUR release. A predecessor that rejects
      // still lets us through (both branches resolve to `held`), so a
      // single failed turn never wedges the whole session.
      const mine = prev.then(
        () => held,
        () => held,
      );
      tails.set(key, mine);

      const cleanup = () => {
        // Drop the map entry once we're the tail, so idle sessions don't
        // leak Promise references.
        if (tails.get(key) === mine) {
          tails.delete(key);
        }
      };

      try {
        await waitForTurn(prev, waitSignal);
      } catch (error) {
        // Never acquired the critical section — release immediately so
        // successors aren't blocked by an aborted waiter, then surface
        // the abort to the caller.
        release();
        cleanup();
        throw error;
      }

      try {
        return await fn();
      } finally {
        release();
        cleanup();
      }
    },
  };
}

/**
 * Wait for `prev` (the previous holder's release) to settle, racing it
 * against `signal` so a cancelled caller stops waiting instead of
 * deadlocking. Predecessor rejections are swallowed — a failed turn still
 * releases the lock to the next waiter.
 */
function waitForTurn(prev: Promise<void>, signal?: AbortSignal): Promise<void> {
  const settled = prev.then(
    () => {},
    () => {},
  );

  if (!signal) return settled;
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    void settled.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

/**
 * No-op {@link SessionLock} for `sessionLock: false` — runs `fn` with no
 * serialization at all. Opt out only when an external mechanism (sticky
 * routing, a single-writer guarantee) already serializes same-session
 * turns.
 */
export function noopSessionLock(): SessionLock {
  return {
    withLock<T>(_key: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  };
}
