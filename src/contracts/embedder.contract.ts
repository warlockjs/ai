/** Token usage returned from an embedding request. */
export type EmbeddingUsage = {
  promptTokens: number;
  totalTokens: number;
};

/** Result of embedding a single string input. */
export type EmbeddingResult = {
  vector: number[];
  dimensions: number;
  usage: EmbeddingUsage;
};

/** Result of embedding a batch of string inputs. */
export type EmbeddingBatchResult = {
  vectors: number[][];
  dimensions: number;
  usage: EmbeddingUsage;
};

/**
 * Configuration passed to `SDKAdapterContract.embedder()`.
 *
 * `dimensions` is an optional override supported by models like
 * `text-embedding-3-*` that allow output truncation. When omitted,
 * the adapter resolves `dimensions` lazily from the first response.
 */
export type EmbedderConfig = {
  name: string;
  dimensions?: number;
  [key: string]: unknown;
};

/**
 * Provider-neutral contract for an embedding model.
 *
 * Single-input and batch are split into separate methods (`embed` vs
 * `embedMany`) rather than one overloaded call — they have different
 * cost profiles, different per-request limits, and different failure
 * modes. Splitting keeps each method's JSDoc narrow and avoids the
 * overload-narrowing trap when callers hold a `string | string[]`.
 *
 * @example
 * const embedder = openai.embedder({ name: "text-embedding-3-small" });
 * const { vector, dimensions } = await embedder.embed("Hello world");
 * const { vectors } = await embedder.embedMany(["doc 1", "doc 2"]);
 */
export interface EmbedderContract {
  readonly name: string;
  readonly provider: string;
  /**
   * Resolved output dimension count. Starts at `0` when no config
   * override is given, then is set to the response's vector length on
   * the first successful `embed()` / `embedMany()` call and cached.
   *
   * Not declared `readonly` because implementations populate it
   * lazily. Treat the value as a post-first-call snapshot.
   */
  dimensions: number;

  /** Embed a single string into a vector. */
  embed(input: string): Promise<EmbeddingResult>;

  /**
   * Embed a batch of strings in a single provider call. The whole
   * batch is one request, so total input tokens must fit under the
   * provider's per-request cap. Result `vectors` are returned in the
   * same order as `inputs`.
   */
  embedMany(inputs: string[]): Promise<EmbeddingBatchResult>;
}
