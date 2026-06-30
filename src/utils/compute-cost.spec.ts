import { describe, expect, it } from "vitest";
import type { ModelPricing } from "../contracts/result/model-pricing.type";
import type { Usage } from "../contracts/result/usage.type";
import { accumulateCost, computeCost, mergeUsage } from "./compute-cost";

const PRICING: ModelPricing = {
  input: 0.15,
  output: 0.6,
  cachedInput: 0.075,
};

const NO_CACHED: ModelPricing = {
  input: 2.5,
  output: 10,
};

function usage(partial: Partial<Usage>): Usage {
  return {
    input: 0,
    output: 0,
    total: 0,
    ...partial,
  };
}

describe("computeCost", () => {
  it("returns undefined when pricing is not configured", () => {
    const result = computeCost(usage({ input: 1000, output: 500 }), undefined);

    expect(result).toBeUndefined();
  });

  it("returns a per-channel breakdown for input + output", () => {
    const result = computeCost(usage({ input: 1_000_000, output: 500_000 }), PRICING);

    expect(result).toEqual({
      input: 0.15,
      output: 0.3,
    });
  });

  it("splits cached input out at the discounted rate", () => {
    const result = computeCost(
      usage({ input: 1_000_000, output: 500_000, cachedTokens: 400_000 }),
      PRICING,
    );

    // 600_000 uncached input @ $0.15/M = $0.090
    // 400_000 cached input  @ $0.075/M = $0.030
    // 500_000 output        @ $0.60/M  = $0.300
    expect(result?.input).toBeCloseTo(0.09);
    expect(result?.cachedInput).toBeCloseTo(0.03);
    expect(result?.output).toBeCloseTo(0.3);
  });

  it("falls back to full input rate when pricing omits cachedInput", () => {
    const result = computeCost(
      usage({ input: 1_000_000, output: 0, cachedTokens: 500_000 }),
      NO_CACHED,
    );

    // Cached tokens still get billed — at the full input rate, since
    // the adapter didn't publish a cache-hit discount.
    expect(result?.input).toBeCloseTo(1.25); // 500K @ $2.5/M
    expect(result?.cachedInput).toBeCloseTo(1.25); // 500K @ $2.5/M (fallback)
  });

  it("omits cachedInput channel when no cached tokens were reported", () => {
    const result = computeCost(usage({ input: 1000, output: 500 }), PRICING);

    expect(result?.cachedInput).toBeUndefined();
  });

  it("treats over-reporting of cachedTokens as zero uncached input", () => {
    const result = computeCost(
      usage({ input: 1000, output: 0, cachedTokens: 9999 }),
      PRICING,
    );

    expect(result?.input).toBe(0); // Math.max(0, ...) clamps the negative
    expect(result?.cachedInput).toBeGreaterThan(0);
  });

  it("returns zero costs for zero token counts", () => {
    const result = computeCost(usage({}), PRICING);

    expect(result).toEqual({ input: 0, output: 0 });
  });
});

describe("accumulateCost", () => {
  it("returns undefined when both sides are undefined", () => {
    expect(accumulateCost(undefined, undefined)).toBeUndefined();
  });

  it("returns the child verbatim when parent is undefined", () => {
    const child: ModelPricing = { input: 0.1, output: 0.2 };
    const result = accumulateCost(undefined, child);

    expect(result).toEqual(child);
    expect(result).not.toBe(child); // shallow copy
  });

  it("returns the parent unchanged when child is undefined (unpriced child doesn't erase priced sibling)", () => {
    const parent: ModelPricing = { input: 0.1, output: 0.2 };
    const result = accumulateCost(parent, undefined);

    expect(result).toBe(parent);
  });

  it("sums input + output per channel", () => {
    const parent: ModelPricing = { input: 0.1, output: 0.2 };
    const child: ModelPricing = { input: 0.05, output: 0.1 };

    const merged = accumulateCost(parent, child);

    expect(merged?.input).toBeCloseTo(0.15);
    expect(merged?.output).toBeCloseTo(0.3);
  });

  it("sums cachedInput when either side reports it", () => {
    const parent: ModelPricing = { input: 0.1, output: 0.2, cachedInput: 0.01 };
    const child: ModelPricing = { input: 0.05, output: 0.1, cachedInput: 0.005 };

    expect(accumulateCost(parent, child)?.cachedInput).toBeCloseTo(0.015);
  });

  it("preserves cachedInput when only one side reports it", () => {
    const parent: ModelPricing = { input: 0.1, output: 0.2 };
    const child: ModelPricing = { input: 0.05, output: 0.1, cachedInput: 0.005 };

    const merged = accumulateCost(parent, child);

    expect(merged?.cachedInput).toBe(0.005);
  });

  it("omits cachedInput channel when neither side reports it", () => {
    const parent: ModelPricing = { input: 0.1, output: 0.2 };
    const child: ModelPricing = { input: 0.05, output: 0.1 };

    expect(accumulateCost(parent, child)).not.toHaveProperty("cachedInput");
  });

  it("handles cachedOutput identically to cachedInput", () => {
    const parent: ModelPricing = { input: 0.1, output: 0.2, cachedOutput: 0.003 };
    const child: ModelPricing = { input: 0.05, output: 0.1 };

    expect(accumulateCost(parent, child)?.cachedOutput).toBe(0.003);
  });
});

describe("mergeUsage", () => {
  it("sums the scalar token channels into the target in place", () => {
    const target: Usage = { input: 10, output: 5, total: 15 };

    mergeUsage(target, { input: 20, output: 10, total: 30 });

    expect(target).toMatchObject({ input: 30, output: 15, total: 45 });
  });

  it("accumulates cachedTokens / reasoningTokens / cacheWriteTokens when reported", () => {
    const target: Usage = { input: 0, output: 0, total: 0, cachedTokens: 4, reasoningTokens: 2 };

    mergeUsage(target, {
      input: 0,
      output: 0,
      total: 0,
      cachedTokens: 6,
      reasoningTokens: 3,
      cacheWriteTokens: 8,
    });

    expect(target.cachedTokens).toBe(10);
    expect(target.reasoningTokens).toBe(5);
    expect(target.cacheWriteTokens).toBe(8);
  });

  it("leaves an optional channel undefined when no contributor reports it", () => {
    const target: Usage = { input: 0, output: 0, total: 0 };

    mergeUsage(target, { input: 1, output: 1, total: 2 });

    expect(target.cachedTokens).toBeUndefined();
    expect(target.reasoningTokens).toBeUndefined();
    expect(target.cacheWriteTokens).toBeUndefined();
  });

  it("merges the cost breakdown so an unpriced child can't erase a priced target", () => {
    const target: Usage = { input: 0, output: 0, total: 0, cost: { input: 0.1, output: 0.2 } };

    mergeUsage(target, { input: 0, output: 0, total: 0 });

    expect(target.cost).toEqual({ input: 0.1, output: 0.2 });
  });

  it("propagates a priced child's cost onto an unpriced target", () => {
    const target: Usage = { input: 0, output: 0, total: 0 };

    mergeUsage(target, { input: 0, output: 0, total: 0, cost: { input: 0.03, output: 0.04 } });

    expect(target.cost?.input).toBeCloseTo(0.03);
    expect(target.cost?.output).toBeCloseTo(0.04);
  });
});
