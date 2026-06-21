/**
 * Run an async `worker` over every index `0..total-1` with at most
 * `limit` workers in flight at any moment, preserving nothing about
 * completion order (the worker is responsible for recording results
 * positionally). Resolves once every index has settled.
 *
 * A fixed pool of `limit` runners each pull the next unclaimed index
 * from a shared cursor — this keeps exactly `limit` items in flight
 * even when item durations vary wildly, unlike fixed-size chunking
 * which stalls a chunk on its slowest member.
 *
 * `limit` is clamped to `[1, total]`: a non-positive limit runs fully
 * serially, a limit larger than `total` simply starts every item.
 * `total === 0` resolves immediately.
 *
 * The worker must never reject — it owns its own try/catch and records
 * outcomes. A rejection here would abort sibling runners, which is not
 * the batch contract (one item's failure never cancels another's).
 */
export async function runWithConcurrency(
  total: number,
  limit: number,
  worker: (index: number) => Promise<void>,
): Promise<void> {
  if (total <= 0) {
    return;
  }

  const poolSize = Math.max(1, Math.min(limit, total));
  let cursor = 0;

  const runner = async (): Promise<void> => {
    while (cursor < total) {
      const index = cursor;
      cursor += 1;
      await worker(index);
    }
  };

  const pool: Promise<void>[] = [];
  for (let slot = 0; slot < poolSize; slot++) {
    pool.push(runner());
  }

  await Promise.all(pool);
}
