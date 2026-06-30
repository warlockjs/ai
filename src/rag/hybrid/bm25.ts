import type { RankedItem } from "./rrf";

/** A document to score lexically. */
export type LexicalDoc = { id: string; text: string };

const BM25_K1 = 1.5;
const BM25_B = 0.75;

/** Lowercase + split on non-word characters; drop empties. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
}

/**
 * Rank `docs` against `query` with BM25 (A4) — the lexical half of hybrid
 * retrieval. Scores keyword overlap with TF saturation (`k1`) and length
 * normalization (`b`) over the candidate set, so an exact-term match
 * surfaces even when dense embeddings miss it. Returns docs sorted by
 * score (highest first); zero-score docs are dropped.
 *
 * Operates over the supplied candidate set (typically the dense retriever's
 * over-fetch), so it needs no global corpus index — ideal for fusing with
 * a vector ranking via {@link reciprocalRankFusion}.
 */
export function bm25Rank(query: string, docs: ReadonlyArray<LexicalDoc>): RankedItem[] {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0 || docs.length === 0) return [];

  const tokenized = docs.map(doc => ({ id: doc.id, terms: tokenize(doc.text) }));
  const avgLen =
    tokenized.reduce((sum, d) => sum + d.terms.length, 0) / tokenized.length || 1;

  // Document frequency per query term, across the candidate set.
  const df = new Map<string, number>();
  for (const term of queryTerms) {
    df.set(
      term,
      tokenized.filter(d => d.terms.includes(term)).length,
    );
  }

  const n = tokenized.length;

  const scored = tokenized.map(doc => {
    const len = doc.terms.length || 1;
    let score = 0;

    for (const term of queryTerms) {
      const tf = doc.terms.filter(t => t === term).length;
      if (tf === 0) continue;

      const docFreq = df.get(term) ?? 0;
      // BM25 idf (with the +1 to keep it non-negative).
      const idf = Math.log(1 + (n - docFreq + 0.5) / (docFreq + 0.5));
      const numerator = tf * (BM25_K1 + 1);
      const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (len / avgLen));
      score += idf * (numerator / denominator);
    }

    return { id: doc.id, score };
  });

  return scored.filter(item => item.score > 0).sort((a, b) => b.score - a.score);
}
