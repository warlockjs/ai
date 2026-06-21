import type { ModelPricing } from "../contracts/result/model-pricing.type";
import type { Usage } from "../contracts/result/usage.type";

/**
 * Compute a per-channel USD cost breakdown for a single `Usage` against
 * a model's pricing table. Returns `undefined` when no pricing is
 * configured — the framework treats unpriced runs as "cost unknown,"
 * not "cost zero," so dashboards can distinguish free-tier from
 * un-instrumented.
 *
 * **Shape mirrors `ModelPricing`** — `input`, `output`, optional
 * `cachedInput` / `cachedOutput`. Consumers needing a scalar total
 * sum the populated fields. The breakdown is the value-add: it tells
 * downstream tooling HOW the total was reached (input-vs-output
 * share, cache savings) without re-deriving against pricing tables
 * that may have shifted since the report was written.
 *
 * **Cache-aware.** `usage.cachedTokens` is the subset of `usage.input`
 * served from the provider's prompt cache and bills at
 * `pricing.cachedInput` (falls back to full `pricing.input` when the
 * provider doesn't publish a cache rate). The remaining `input -
 * cachedTokens` bills at full rate and shows up in `cost.input`. The
 * `cachedOutput` channel is reserved for Anthropic-style cache writes;
 * until an adapter populates `usage.cacheWriteTokens`, the framework
 * leaves it undefined.
 *
 * Pricing values are USD-per-million-tokens. The function divides
 * once at the end to avoid floating-point accumulation error on
 * per-token math.
 *
 * @example
 * const usage: Usage = { input: 150_000, output: 30_000, total: 180_000, cachedTokens: 90_000 };
 * const cost = computeCost(usage, { input: 0.15, output: 0.6, cachedInput: 0.075 });
 * // cost = {
 * //   input: (60_000 * 0.15) / 1e6 = 0.009,
 * //   output: (30_000 * 0.6) / 1e6 = 0.018,
 * //   cachedInput: (90_000 * 0.075) / 1e6 = 0.00675,
 * // }
 */
export function computeCost(usage: Usage, pricing: ModelPricing | undefined): ModelPricing | undefined {
  if (!pricing) {
    return undefined;
  }

  const cachedInput = usage.cachedTokens ?? 0;
  const uncachedInput = Math.max(0, usage.input - cachedInput);

  const cost: ModelPricing = {
    input: (uncachedInput * pricing.input) / 1_000_000,
    output: (usage.output * pricing.output) / 1_000_000,
  };

  if (cachedInput > 0) {
    const cachedInputRate = pricing.cachedInput ?? pricing.input;
    cost.cachedInput = (cachedInput * cachedInputRate) / 1_000_000;
  }

  return cost;
}

/**
 * Merge a child's cost breakdown into a running parent total. Each
 * channel (`input`, `output`, `cachedInput`, `cachedOutput`) sums
 * independently — an undefined channel on either side is treated as
 * zero contribution rather than dropping the other side's value. A
 * single unpriced child should never erase the cost of its priced
 * siblings.
 *
 * Returns the new parent breakdown, or `undefined` when neither parent
 * nor child carried any cost data (preserves the "no priced
 * contributor has appeared yet" signal that distinguishes "missing
 * pricing" from "genuinely zero").
 */
export function accumulateCost(
  parent: ModelPricing | undefined,
  child: ModelPricing | undefined,
): ModelPricing | undefined {
  if (!child) {
    return parent;
  }

  if (!parent) {
    return { ...child };
  }

  const merged: ModelPricing = {
    input: parent.input + child.input,
    output: parent.output + child.output,
  };

  const cachedInput = sumOptional(parent.cachedInput, child.cachedInput);
  if (cachedInput !== undefined) {
    merged.cachedInput = cachedInput;
  }

  const cachedOutput = sumOptional(parent.cachedOutput, child.cachedOutput);
  if (cachedOutput !== undefined) {
    merged.cachedOutput = cachedOutput;
  }

  return merged;
}

/**
 * Add two optional numbers, treating either side's `undefined` as
 * zero — but return `undefined` when both are absent. Keeps "this
 * channel was never reported anywhere" distinguishable from "this
 * channel was reported as 0."
 */
function sumOptional(parent: number | undefined, child: number | undefined): number | undefined {
  if (parent === undefined && child === undefined) {
    return undefined;
  }

  return (parent ?? 0) + (child ?? 0);
}
