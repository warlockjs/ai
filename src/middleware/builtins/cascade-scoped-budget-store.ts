import type { Model as CascadeModel } from "@warlock.js/cascade";
import type {
  ScopedBudgetReserveInput,
  ScopedBudgetReserveResult,
  ScopedBudgetStore,
} from "./scoped-budget-store.type";

/** Cascade model static surface required by the scoped-budget ledger. */
export type CascadeScopedBudgetModel = typeof CascadeModel;

/** Configuration for a Cascade-backed scoped-budget ledger. */
export type CascadeScopedBudgetStoreOptions = {
  /** An application-owned Cascade model for ledger rows. */
  model?: CascadeScopedBudgetModel;
  /** Table/collection used by an internal Cascade model when `model` is omitted. */
  table?: string;
};

/** Raised when the optional Cascade peer dependency cannot be loaded. */
export class CascadeScopedBudgetStoreUnavailableError extends Error {
  public constructor(options?: { cause?: unknown }) {
    super(
      "Cascade scoped budgets require the optional @warlock.js/cascade package. Install it before creating this store.",
    );
    this.name = "CascadeScopedBudgetStoreUnavailableError";

    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * Create a Cascade-backed scoped-budget ledger.
 *
 * The supplied table must have a unique `(key, windowStart, unit)` index.
 * Cascade is loaded only here so applications that do not use this optional
 * store never resolve its package.
 */
export async function cascadeScopedBudgetStore(
  options: CascadeScopedBudgetStoreOptions,
): Promise<ScopedBudgetStore> {
  const model = options.model ?? (await createLedgerModel(options.table));

  async function initialize(input: ScopedBudgetReserveInput): Promise<void> {
    try {
      await model.findOneAndUpdate(
        identity(input),
        { $setOnInsert: { ...identity(input), used: 0 } },
        { upsert: true },
      );
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
    }
  }

  async function change(
    input: ScopedBudgetReserveInput,
    delta: number,
    enforceLimit: boolean,
  ): Promise<ScopedBudgetReserveResult> {
    await initialize(input);
    const updated = await model.findOneAndUpdate(
      { ...identity(input), ...usageCondition(delta, input.limit, enforceLimit) },
      { $inc: { used: delta } },
      { trustedFilter: true },
    );

    if (updated) {
      return { allowed: true, used: readUsed(updated) };
    }

    const current = await model.findOneAndUpdate(identity(input), { $inc: { used: 0 } });
    return { allowed: false, used: current ? readUsed(current) : 0 };
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

async function createLedgerModel(table: string | undefined): Promise<CascadeScopedBudgetModel> {
  if (!table) {
    throw new Error("cascadeScopedBudgetStore requires either a Cascade model or a table name.");
  }

  const ledgerTable = table;

  try {
    const { Model } = await import("@warlock.js/cascade");

    class ScopedBudgetLedger extends Model {
      public static table = ledgerTable;
      public static autoGenerateId = false;
    }

    return ScopedBudgetLedger;
  } catch (error) {
    throw new CascadeScopedBudgetStoreUnavailableError({ cause: error });
  }
}

function identity(input: ScopedBudgetReserveInput): Record<string, unknown> {
  return { key: input.key, windowStart: input.windowStart, unit: input.unit };
}

function usageCondition(
  delta: number,
  limit: number,
  enforceLimit: boolean,
): Record<string, unknown> {
  if (delta < 0) {
    return { used: { $gte: -delta } };
  }

  if (enforceLimit) {
    return { used: { $lte: limit - delta } };
  }

  return {};
}

function readUsed(model: CascadeModel): number {
  const used = model.get("used") as unknown;
  return typeof used === "number" ? used : 0;
}

function isDuplicateKeyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  return code === 11000 || code === "23505";
}
