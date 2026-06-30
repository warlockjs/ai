import type { Message } from "../../contracts/conversation-message.type";
import type { ModelContract } from "../../contracts/model.contract";
import type { RetrievedChunk } from "../contracts/citation.type";
import type { RagReranker } from "./reranker.contract";

/** Options for the {@link llmReranker}. */
export type LlmRerankerOptions = {
  /** The model used to score candidate relevance. Required. */
  model: ModelContract;
  /**
   * How many candidates to score per model call. Larger batches mean
   * fewer round-trips but a longer prompt. Default `10`.
   */
  batchSize?: number;
};

/**
 * A single relevance score the model returns for a candidate, in `[0, 1]`,
 * keyed by the candidate's position in the batch.
 */
type ScoreLine = {
  index: number;
  score: number;
};

/**
 * Build the scoring prompt — the model rates each candidate's relevance to
 * the query on a `0..1` scale and replies with one `index: score` line per
 * candidate. Kept terse and JSON-light so any chat model can answer.
 */
function buildPrompt(query: string, candidates: RetrievedChunk[]): Message[] {
  const lines = candidates
    .map((candidate, index) => `[${index}] ${candidate.text}`)
    .join("\n\n");

  return [
    {
      role: "system",
      content:
        "You are a relevance grader. For each numbered passage, rate how well it answers the query on a scale from 0 (irrelevant) to 1 (fully relevant). Reply with ONLY a JSON array of objects like [{\"index\":0,\"score\":0.9}], one entry per passage, no prose.",
    },
    {
      role: "user",
      content: `Query: ${query}\n\nPassages:\n${lines}`,
    },
  ];
}

/**
 * Parse the model's reply into a score map. Tolerant of surrounding prose:
 * extracts the first JSON array and reads `{ index, score }` entries.
 * Returns an empty map when nothing parseable is found, so the caller can
 * fall back to the original order.
 */
function parseScores(reply: string): Map<number, number> {
  const scores = new Map<number, number>();
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");

  if (start === -1 || end === -1 || end <= start) {
    return scores;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return scores;
  }

  if (!Array.isArray(parsed)) {
    return scores;
  }

  for (const entry of parsed as ScoreLine[]) {
    if (
      entry &&
      typeof entry.index === "number" &&
      typeof entry.score === "number" &&
      Number.isFinite(entry.score)
    ) {
      scores.set(entry.index, Math.max(0, Math.min(1, entry.score)));
    }
  }

  return scores;
}

/**
 * Optional model-backed reranker.
 *
 * Asks an LLM to grade each over-fetched candidate's relevance to the
 * query on a `0..1` scale, then sorts descending by the model's score.
 * Candidates the model does not score keep their original cosine score, so
 * a partial/garbled reply degrades gracefully rather than dropping hits.
 * Scoring is batched (`batchSize`) to bound prompt length.
 *
 * Unlike {@link keywordReranker}, this costs one or more model calls per
 * retrieval — opt in only when precision matters more than latency/cost.
 *
 * @example
 * const kb = ai.rag({
 *   embedder,
 *   store,
 *   reranker: ai.rag.llmReranker({ model: openai.model({ name: "gpt-4o-mini" }) }),
 * });
 */
export function llmReranker(options: LlmRerankerOptions): RagReranker {
  const batchSize = options.batchSize ?? 10;

  return {
    name: "llm",
    async rerank(query: string, candidates: RetrievedChunk[]): Promise<RetrievedChunk[]> {
      if (candidates.length === 0) {
        return [];
      }

      const rescored: RetrievedChunk[] = [];

      for (let offset = 0; offset < candidates.length; offset += batchSize) {
        const batch = candidates.slice(offset, offset + batchSize);
        const response = await options.model.complete(buildPrompt(query, batch));
        const scores = parseScores(response.content);

        batch.forEach((candidate, index) => {
          const score = scores.has(index) ? (scores.get(index) as number) : candidate.score;

          rescored.push({
            ...candidate,
            score,
            citation: { ...candidate.citation, score },
          });
        });
      }

      return rescored.sort((first, second) => second.score - first.score);
    },
  };
}
