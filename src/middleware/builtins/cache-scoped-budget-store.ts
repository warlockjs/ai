import type { CacheDriver } from "@warlock.js/cache";
import type {
  ScopedBudgetReserveInput,
  ScopedBudgetReserveResult,
  ScopedBudgetStore,
} from "./scoped-budget-store.type";

type ScopedBudgetCache = Pick<CacheDriver<unknown, unknown>, "update">;

/** Options for the optional cache-backed scoped-budget store. */
export type CacheScopedBudgetStoreOptions = {
  cache?: ScopedBudgetCache;
  prefix?: string;
};

/**
 * Create a cache-backed scoped-budget store.
 *
 * `@warlock.js/cache` is lazy-loaded only when no cache instance is supplied,
 * preserving AI's optional-peer import boundary. The selected cache driver's
 * `update` implementation must be atomic across every node that shares a
 * scoped budget.
 */
export async function cacheScopedBudgetStore(
  options: CacheScopedBudgetStoreOptions = {},
): Promise<ScopedBudgetStore> {
  const cache = options.cache ?? (await import("@warlock.js/cache")).cache;
  const prefix = options.prefix ?? "ai.scoped-budget";

  function ledgerKey(input: ScopedBudgetReserveInput): string {
    return `${prefix}.${encodeURIComponent(input.key)}.${input.windowStart}.${input.unit}`;
  }

  async function change(
    input: ScopedBudgetReserveInput,
    delta: number,
    enforceLimit: boolean,
  ): Promise<ScopedBudgetReserveResult> {
    let result: ScopedBudgetReserveResult = { allowed: false, used: 0 };
    await cache.update<number>(ledgerKey(input), (current) => {
      const used = current ?? 0;
      const next = Math.max(0, used + delta);

      if (enforceLimit && next > input.limit) {
        result = { allowed: false, used: next };
        return used;
      }

      result = { allowed: true, used: next };
      return next;
    });
    return result;
  }

  return {
    reserve(input): Promise<ScopedBudgetReserveResult> {
      return change(input, input.amount, true);
    },
    commit(input, actual): Promise<ScopedBudgetReserveResult> {
      return change(input, actual - input.amount, true);
    },
    async refund(input, amount = input.amount): Promise<number> {
      return (await change(input, -amount, false)).used;
    },
  };
}
