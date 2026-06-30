import type { ModelContract } from "../../contracts/model.contract";

/** Options for {@link multiQuery}. */
export type MultiQueryOptions = {
  /** How many alternative phrasings to request. Default 3. */
  n?: number;
  /** Include the original query in the returned list. Default true. */
  includeOriginal?: boolean;
};

/**
 * Multi-query expansion (A4) — ask a model for several alternative
 * phrasings of `query`, so retrieval covers vocabulary the original
 * wording missed (synonyms, specificity, rephrasings). Pair the variants
 * with {@link hybridRank} / a vector search and fuse the per-variant hits.
 *
 * Deterministic, dependency-light parsing: the model is asked for one
 * query per line; bullets / numbering are stripped, blanks dropped, and
 * the set is de-duplicated. Returns the original (unless opted out) plus
 * up to `n` variants.
 *
 * @example
 * const queries = await multiQuery(model, "how do I cancel?", { n: 3 });
 * // → ["how do I cancel?", "cancel my subscription", "end my plan", ...]
 */
export async function multiQuery(
  model: ModelContract,
  query: string,
  options: MultiQueryOptions = {},
): Promise<string[]> {
  const n = options.n ?? 3;
  const includeOriginal = options.includeOriginal ?? true;

  const prompt =
    `Rewrite the following search query into ${n} alternative phrasings that would ` +
    `retrieve relevant documents. Output ONE query per line, no numbering or commentary.\n\n` +
    `Query: ${query}`;

  const response = await model.complete([{ role: "user", content: prompt }]);

  const variants = response.content
    .split("\n")
    .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const out: string[] = [];

  const add = (q: string) => {
    const key = q.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(q);
    }
  };

  if (includeOriginal) add(query);
  for (const variant of variants.slice(0, n)) add(variant);

  return out;
}
