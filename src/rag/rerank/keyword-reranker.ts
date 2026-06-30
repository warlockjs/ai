import type { RetrievedChunk } from "../contracts/citation.type";
import type { RagReranker } from "./reranker.contract";

/** Options for the {@link keywordReranker}. */
export type KeywordRerankerOptions = {
  /**
   * Weight of the lexical-overlap signal blended with the original cosine
   * score, in `[0, 1]`. `1` ranks purely by keyword overlap; `0` keeps the
   * cosine order. Default `0.5`.
   */
  weight?: number;
};

/** Splits text into lowercase alphanumeric terms. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0);
}

/**
 * Zero-dependency lexical reranker (a BM25-lite, IDF-free keyword overlap).
 *
 * For each candidate it computes the fraction of distinct query terms that
 * appear in the chunk, blends that with the candidate's original cosine
 * score by `weight`, and sorts descending. A pure-lexical pass costs
 * nothing beyond string splits — no peer, no model — so it is the
 * recommended opt-in reranker when an embedding-only ranking surfaces a
 * keyword-rich chunk too low.
 *
 * Ties (equal blended score) preserve the incoming order, so the cosine
 * ranking breaks ties deterministically.
 *
 * @example
 * const kb = ai.rag({ embedder, store, reranker: ai.rag.keywordReranker() });
 */
export function keywordReranker(options: KeywordRerankerOptions = {}): RagReranker {
  const weight = options.weight ?? 0.5;

  return {
    name: "keyword",
    async rerank(query: string, candidates: RetrievedChunk[]): Promise<RetrievedChunk[]> {
      if (candidates.length === 0) {
        return [];
      }

      const queryTerms = new Set(tokenize(query));

      if (queryTerms.size === 0) {
        return [...candidates];
      }

      const scored = candidates.map((candidate, position) => {
        const chunkTerms = new Set(tokenize(candidate.text));

        let overlap = 0;
        for (const term of queryTerms) {
          if (chunkTerms.has(term)) {
            overlap += 1;
          }
        }

        const lexical = overlap / queryTerms.size;
        const blended = weight * lexical + (1 - weight) * candidate.score;

        return { candidate, blended, position };
      });

      scored.sort((first, second) => {
        if (second.blended !== first.blended) {
          return second.blended - first.blended;
        }

        // Stable on ties: keep the incoming (cosine) order.
        return first.position - second.position;
      });

      return scored.map((entry) => ({
        ...entry.candidate,
        score: entry.blended,
        citation: { ...entry.candidate.citation, score: entry.blended },
      }));
    },
  };
}
