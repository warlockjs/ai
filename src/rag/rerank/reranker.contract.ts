import type { RetrievedChunk } from "../contracts/citation.type";

/**
 * Reranks an over-fetched candidate set against the query before the
 * pipeline slices to `topK`. Optional — when no reranker is configured the
 * raw cosine order from the vector store is kept.
 *
 * A reranker receives the candidates already scored by cosine similarity
 * and returns them reordered (and typically re-scored). The pipeline does
 * NOT trust the input order; it relies entirely on the returned order. A
 * reranker that throws is caught by the pipeline, which falls back to the
 * cosine order — so an implementation may throw to opt out of a given
 * query rather than returning garbage.
 */
export interface RagReranker {
  /** Stable name for logs / diagnostics. */
  readonly name: string;
  /**
   * Reorder (and optionally re-score) `candidates` by relevance to
   * `query`. Returns the reranked list; the pipeline slices `topK` from
   * the front.
   */
  rerank(query: string, candidates: RetrievedChunk[]): Promise<RetrievedChunk[]>;
}
