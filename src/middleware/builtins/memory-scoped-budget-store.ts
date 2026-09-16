import type {
  ScopedBudgetReserveInput,
  ScopedBudgetReserveResult,
  ScopedBudgetStore,
} from "./scoped-budget-store.type";

type Ledger = Map<string, number>;

/** Create an in-process scoped-budget store for tests and single-node development. */
export function memoryScopedBudgetStore(): ScopedBudgetStore {
  const ledger: Ledger = new Map();
  const queues = new Map<string, Promise<void>>();

  function ledgerKey(input: ScopedBudgetReserveInput): string {
    return `${input.key}:${input.windowStart}:${input.unit}`;
  }

  async function atomically<T>(key: string, action: () => T | Promise<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    queues.set(key, previous.then(() => current));
    await previous;

    try {
      return await action();
    } finally {
      release();
      if (queues.get(key) === current) {
        queues.delete(key);
      }
    }
  }

  return {
    async reserve(input): Promise<ScopedBudgetReserveResult> {
      const key = ledgerKey(input);
      return atomically(key, () => {
        const used = ledger.get(key) ?? 0;
        const next = used + input.amount;

        if (next > input.limit) {
          return { allowed: false, used: next };
        }

        ledger.set(key, next);
        return { allowed: true, used: next };
      });
    },
    async commit(input, actual): Promise<ScopedBudgetReserveResult> {
      const key = ledgerKey(input);
      return atomically(key, () => {
        const used = ledger.get(key) ?? 0;
        const next = used - input.amount + actual;

        if (next > input.limit) {
          return { allowed: false, used: next };
        }

        ledger.set(key, Math.max(0, next));
        return { allowed: true, used: Math.max(0, next) };
      });
    },
    async refund(input, amount = input.amount): Promise<number> {
      const key = ledgerKey(input);
      return atomically(key, () => {
        const next = Math.max(0, (ledger.get(key) ?? 0) - amount);
        ledger.set(key, next);
        return next;
      });
    },
  };
}
