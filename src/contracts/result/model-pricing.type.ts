/**
 * Per-million-token USD pricing for a model. All values are in USD per
 * 1,000,000 tokens — the industry-standard unit. Used by the framework
 * to compute `Usage.costUSD` at emit time, so stored reports carry
 * historical cost (not re-derived against today's pricing).
 *
 * **Optionality.** Every field except `input` / `output` is optional.
 * `cachedInput` / `cachedOutput` are populated only when the provider
 * actually meters them (OpenAI prompt-cache hits, Anthropic cache
 * reads / writes). Leave undefined for adapters that don't report a
 * cache channel — cost falls back to full-rate pricing for those
 * tokens.
 *
 * **Where it lives.** Two declaration sites, both optional:
 *
 * 1. `SDK.pricing` — a registry keyed by model name. One source of
 *    truth per provider; matches how providers publish pricing tables.
 * 2. `model({ pricing })` — per-model override at instantiation. Wins
 *    over the SDK-level entry. Critical for multi-tenant projects
 *    where pricing is contract-specific or runtime-resolved.
 *
 * Resolution order: per-model > SDK registry > undefined (no cost
 * computed).
 *
 * @example
 * const pricing: ModelPricing = {
 *   input: 0.15,
 *   output: 0.6,
 *   cachedInput: 0.075,
 * };
 */
export type ModelPricing = {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /**
   * USD per 1M input tokens served from the provider's prompt cache.
   * Typically a fraction of `input`. Falls back to `input` when
   * undefined.
   */
  cachedInput?: number;
  /**
   * USD per 1M tokens written to the provider's prompt cache.
   * Anthropic charges a small premium on cache-write tokens; OpenAI
   * does not. Falls back to `output` when undefined.
   */
  cachedOutput?: number;
  /**
   * USD per 1M reasoning/thinking tokens (`Usage.reasoningTokens`), for
   * providers that price reasoning above the standard output rate.
   * Falls back to `output` when undefined — the common case, since most
   * providers bill reasoning tokens at the output rate.
   *
   * @example
   * const pricing: ModelPricing = { input: 0.15, output: 0.6, reasoning: 0.6 };
   */
  reasoning?: number;
};
