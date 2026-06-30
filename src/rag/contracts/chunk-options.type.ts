/** Splitter strategy used to break a document's text before embedding. */
export type ChunkType = "recursive" | "sentence" | "fixed" | "markdown";

/**
 * How a document's text is split before embedding.
 *
 * All sizing is in **characters**, not tokens, so the pipeline stays
 * tokenizer-free (the embedder owns token counting). A character budget
 * is deterministic and dep-free; it may occasionally over/under-shoot a
 * provider's per-request token cap, which the sub-batching guard in
 * `index()` absorbs.
 */
export type ChunkOptions = {
  /** Splitter strategy. Default `"recursive"`. */
  type?: ChunkType;
  /** Target chunk size in characters (not tokens, to stay tokenizer-free). Default 1000. */
  size?: number;
  /** Character overlap carried between adjacent chunks. Default 200. */
  overlap?: number;
  /**
   * Ordered separators for the `"recursive"` splitter, tried largest-unit
   * first. Default `["\n\n", "\n", ". ", " ", ""]`.
   */
  separators?: string[];
};

/**
 * A single chunk emitted by a splitter — its text plus the exact
 * `[start, end)` character span inside the original source text, so the
 * citation's `span` is precise.
 */
export type Chunk = {
  /** The chunk text. */
  text: string;
  /** 0-based index of the chunk within its source document. */
  index: number;
  /** Character span `[start, end)` of the chunk inside the original source text. */
  span: [start: number, end: number];
};
