/** One item's id paired with a fused relevance score. */
export type RankedItem = { id: string; score: number };

/**
 * Reciprocal Rank Fusion (A4) — combine several independently-ranked
 * lists of ids into one consensus ranking. Each list contributes
 * `1 / (k + rank)` to an id's score (rank is 0-based within that list), so
 * an id near the top of multiple lists rises even if no single list ranks
 * it first. The classic fusion for hybrid (dense + lexical) retrieval
 * because it needs no score calibration between the lists.
 *
 * `k` (default 60, the standard) dampens the contribution of lower ranks.
 * Returns ids sorted by fused score, highest first.
 *
 * @example
 * reciprocalRankFusion([["a", "b", "c"], ["b", "a"]]);
 * // → [{ id: "b", ... }, { id: "a", ... }, { id: "c", ... }]
 */
export function reciprocalRankFusion(
  rankedLists: ReadonlyArray<ReadonlyArray<string>>,
  k = 60,
): RankedItem[] {
  const scores = new Map<string, number>();

  for (const list of rankedLists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
    });
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
