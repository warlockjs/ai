import type { ModelPricing } from "./model-pricing.type";

/**
 * Token usage statistics for a single LLM call or aggregated across trips.
 *
 * `cachedTokens` is optional and represents the subset of `input` that
 * was served from the provider's prompt cache (OpenAI's
 * `prompt_tokens_details.cached_tokens`, Anthropic's
 * `cache_read_input_tokens`). Cache-hit tokens are usually billed at
 * a fraction of the full input rate — separate accounting lets cost
 * code price them correctly. Defaults to 0 / undefined when the
 * provider doesn't report it.
 *
 * @example
 * const usage: Usage = {
 *   input: 150,
 *   output: 320,
 *   total: 470,
 *   cachedTokens: 120,
 *   cost: { input: 0.0000045, output: 0.000192, cachedInput: 0.000009 },
 * };
 */
export type Usage = {
  /** Number of input/prompt tokens consumed (includes cachedTokens). */
  input: number;
  /** Number of output/completion tokens generated. */
  output: number;
  /** Total tokens (input + output). */
  total: number;
  /**
   * Subset of `input` served from the provider's prompt cache. Billed
   * at a discounted rate when cost is computed downstream. Optional —
   * providers that don't report cache hits leave this undefined.
   */
  cachedTokens?: number;
  /**
   * Subset of `output` the provider attributes to internal reasoning /
   * thinking before the visible answer (OpenAI reasoning models'
   * `completion_tokens_details.reasoning_tokens`, Anthropic
   * extended-thinking tokens). Counted within `output` for billing
   * unless the provider prices it separately (see
   * `ModelPricing.reasoning`). Optional — undefined when the provider
   * doesn't report a reasoning channel.
   *
   * @example
   * const usage: Usage = { input: 150, output: 320, total: 470, reasoningTokens: 180 };
   */
  reasoningTokens?: number;
  /**
   * Number of input tokens WRITTEN to the provider's prompt cache on
   * this call (Anthropic `cache_creation_input_tokens`). Distinct from
   * `cachedTokens`, which counts read hits. Bills at
   * `ModelPricing.cachedOutput` when set. Optional — undefined for
   * providers/calls with no cache write.
   *
   * @example
   * const usage: Usage = { input: 150, output: 320, total: 470, cacheWriteTokens: 64 };
   */
  cacheWriteTokens?: number;
  /**
   * Cost breakdown in USD, computed at emit time from `tokens × pricing[model]`
   * when the model adapter declared a `ModelPricing`. Same shape as
   * `ModelPricing` (input / output / cachedInput / cachedOutput) so
   * dashboards can tell HOW the total was reached — what share was
   * input vs output, how much the prompt cache saved — instead of
   * looking at one opaque number.
   *
   * Captured as a historical fact so stored reports remain accurate
   * even after the pricing table changes upstream.
   *
   * `undefined` when no pricing is available (legacy adapters, unknown
   * model names, intentionally unpriced free-tier runs). Aggregators
   * merge defined fields and leave undefined ones untouched, so an
   * unpriced child cannot erase priced siblings.
   *
   * For a single scalar total, sum the populated fields:
   * `(cost.input ?? 0) + (cost.output ?? 0) + (cost.cachedInput ?? 0) + (cost.cachedOutput ?? 0)`.
   */
  cost?: ModelPricing;
};
