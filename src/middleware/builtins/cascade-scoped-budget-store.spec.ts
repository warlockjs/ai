import { describe, expect, it } from "vitest";
import {
  cascadeScopedBudgetStore,
  type CascadeScopedBudgetModel,
} from "./cascade-scoped-budget-store";

const input = {
  key: "tenant.42",
  windowStart: Date.UTC(2026, 8, 17),
  unit: "tokens" as const,
  amount: 2,
  limit: 10,
};

describe("cascadeScopedBudgetStore", () => {
  it("initializes a ledger row before conditionally incrementing it", async () => {
    const calls: Array<{
      filter: Record<string, unknown>;
      update: Record<string, unknown>;
      options?: Record<string, unknown>;
    }> = [];
    const model = {
      async findOneAndUpdate(
        filter: Record<string, unknown>,
        update: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) {
        calls.push({ filter, update, options });
        return { get: () => 2 };
      },
    } as unknown as CascadeScopedBudgetModel;
    const store = await cascadeScopedBudgetStore({ model });

    const result = await store.reserve(input);

    expect(result).toEqual({ allowed: true, used: 2 });
    expect(calls).toEqual([
      {
        filter: { key: input.key, windowStart: input.windowStart, unit: input.unit },
        update: {
          $setOnInsert: {
            key: input.key,
            windowStart: input.windowStart,
            unit: input.unit,
            used: 0,
          },
        },
        options: { upsert: true },
      },
      {
        filter: {
          key: input.key,
          windowStart: input.windowStart,
          unit: input.unit,
          used: { $lte: 8 },
        },
        update: { $inc: { used: input.amount } },
        options: { trustedFilter: true },
      },
    ]);
  });

  it("reports the current usage when the conditional increment is rejected", async () => {
    let call = 0;
    const model = {
      async findOneAndUpdate() {
        call += 1;
        return call === 2 ? undefined : { get: () => 10 };
      },
    } as unknown as CascadeScopedBudgetModel;
    const store = await cascadeScopedBudgetStore({ model });

    const result = await store.reserve(input);

    expect(result).toEqual({ allowed: false, used: 10 });
  });
});
