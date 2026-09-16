import { BudgetExceededError, type BudgetExceededErrorOptions } from "./budget-exceeded-error";
import type { ScopedBudgetWindow } from "../middleware/builtins/scoped-budget-store.type";

/**
 * Payload for a scoped-budget rejection. `actual` is intentionally omitted —
 * the constructor derives it from `used` so callers never pass a redundant
 * (and potentially inconsistent) value.
 */
export type ScopedBudgetExceededErrorOptions = Omit<BudgetExceededErrorOptions, "actual"> & {
  key: string;
  window: ScopedBudgetWindow;
  used: number;
};

/** A UTC-windowed budget shared by separate executions was exceeded. */
export class ScopedBudgetExceededError extends BudgetExceededError {
  public readonly key: string;
  public readonly window: ScopedBudgetWindow;
  public readonly used: number;

  public constructor(message: string, options: ScopedBudgetExceededErrorOptions) {
    super(message, { ...options, actual: options.used });
    this.name = "ScopedBudgetExceededError";
    this.key = options.key;
    this.window = options.window;
    this.used = options.used;
  }
}
