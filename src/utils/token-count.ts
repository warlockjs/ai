/**
 * Approximate the number of tokens in a string.
 *
 * Uses the ~4-characters-per-token heuristic, which is accurate enough for
 * GPT-4 family models and most English text. Use this when a real tokenizer
 * (tiktoken, etc.) isn't available or would add native dependencies.
 *
 * @example
 * const tokens = approximateTokenCount("Hello, world!"); // 4
 */
export function approximateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}
