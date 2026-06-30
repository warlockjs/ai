/**
 * Serializes concurrent turns for a single orchestrator session so the
 * read-modify-write of the durable checkpoint can't lose an update
 * (orchestrator C4). The orchestrator wraps each `execute()` / `stream()`
 * / `resume()` turn in `withLock(sessionId, …)`.
 *
 * The framework default is an in-process mutex keyed by `sessionId`
 * ({@link inProcessSessionLock}), which fully serializes same-session
 * turns within ONE process. For a horizontally-scaled deployment (many
 * processes / pods) supply a distributed implementation — Redis
 * `SETNX` / Redlock, Postgres advisory locks, etc. — so the invariant
 * holds across processes too. Set `sessionLock: false` on the config to
 * opt out entirely (only when an external mechanism already serializes
 * same-session turns, e.g. sticky routing).
 *
 * @example
 * // A Redis-backed distributed lock.
 * const redisLock: SessionLock = {
 *   async withLock(key, fn, { signal } = {}) {
 *     await acquireRedisLock(key, { signal });
 *     try {
 *       return await fn();
 *     } finally {
 *       await releaseRedisLock(key);
 *     }
 *   },
 * };
 */
export interface SessionLock {
  /**
   * Acquire the lock for `key` (the sessionId), run `fn`, and release it
   * — even if `fn` throws or rejects. Concurrent calls for the SAME key
   * run one at a time, in arrival order; calls for DIFFERENT keys never
   * contend.
   *
   * `options.signal` aborts the WAIT for the lock (never the critical
   * section once acquired): a caller cancelled while queued rejects with
   * the signal's reason instead of deadlocking behind a stuck holder.
   */
  withLock<T>(
    key: string,
    fn: () => Promise<T>,
    options?: { signal?: AbortSignal },
  ): Promise<T>;
}
