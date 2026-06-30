import { bm25Rank, type LexicalDoc } from "./bm25";
import { reciprocalRankFusion, type RankedItem } from "./rrf";

/**
 * Hybrid rank (A4) — fuse a dense (vector) ranking with a BM25 lexical
 * ranking over the same candidate set via Reciprocal Rank Fusion. Dense
 * retrieval captures semantic similarity; BM25 captures exact-term
 * matches dense embeddings miss (names, ids, rare tokens). Fusing both
 * beats either alone for keyword-heavy queries.
 *
 * `dense` is the vector retriever's result in rank order; `candidates`
 * supplies the text for the lexical pass (typically the same over-fetched
 * set). Returns the fused ranking, highest score first.
 *
 * @example
 * const fused = hybridRank({
 *   query: "invoice 8842 refund",
 *   dense: vectorHits,                 // [{ id }, ...] in similarity order
 *   candidates: vectorHits.map(h => ({ id: h.id, text: h.text })),
 * });
 */
export function hybridRank(params: {
  query: string;
  dense: ReadonlyArray<{ id: string }>;
  candidates: ReadonlyArray<LexicalDoc>;
  k?: number;
}): RankedItem[] {
  const denseIds = params.dense.map(d => d.id);
  const lexicalIds = bm25Rank(params.query, params.candidates).map(r => r.id);

  return reciprocalRankFusion([denseIds, lexicalIds], params.k);
}
