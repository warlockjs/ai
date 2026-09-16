import type { BudgetUnit } from "../../errors";

/** UTC window identities supported by a scoped budget ledger. */
export type ScopedBudgetWindow = "day" | "month";

/** An atomic ledger increment request. */
export type ScopedBudgetReserveInput = {
  key: string;
  windowStart: number;
  unit: BudgetUnit;
  amount: number;
  limit: number;
};

/** Result of an atomic scoped-budget reservation. */
export type ScopedBudgetReserveResult = {
  allowed: boolean;
  used: number;
};

/**
 * Shared ledger used by scoped budgets.
 *
 * `reserve` must atomically reject an increment that would exceed `limit`.
 * `commit` and `refund` let callers settle a preflight estimate with actual
 * usage; the current agent middleware reserves measured trip usage directly.
 */
export interface ScopedBudgetStore {
  reserve(input: ScopedBudgetReserveInput): Promise<ScopedBudgetReserveResult>;
  commit(input: ScopedBudgetReserveInput, actual: number): Promise<ScopedBudgetReserveResult>;
  refund(input: ScopedBudgetReserveInput, amount?: number): Promise<number>;
}
