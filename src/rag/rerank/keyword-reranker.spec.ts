import { describe, expect, it } from "vitest";
import type { RetrievedChunk } from "../contracts/citation.type";
import { keywordReranker } from "./keyword-reranker";

/** Build a RetrievedChunk with a given text + cosine score. */
function makeChunk(text: string, score: number, sourceId = "s"): RetrievedChunk {
  return {
    text,
    score,
    citation: { sourceId, chunkIndex: 0, span: [0, text.length], score },
  };
}

describe("keywordReranker", () => {
  it("reorders by lexical overlap with the query", async () => {
    const reranker = keywordReranker({ weight: 1 });

    const candidates = [
      makeChunk("the weather is mild today", 0.6),
      makeChunk("how to configure caching options", 0.6),
    ];

    const ranked = await reranker.rerank("configure caching", candidates);

    expect(ranked[0].text).toBe("how to configure caching options");
  });

  it("blends lexical overlap with the original cosine score", async () => {
    const reranker = keywordReranker({ weight: 0.5 });

    const candidates = [makeChunk("configure caching here", 0.8)];
    const ranked = await reranker.rerank("configure caching", candidates);

    // weight 0.5 * (2/2 lexical) + 0.5 * 0.8 cosine = 0.9
    expect(ranked[0].score).toBeCloseTo(0.9, 5);
    expect(ranked[0].citation.score).toBeCloseTo(0.9, 5);
  });

  it("is stable on ties (keeps incoming cosine order)", async () => {
    const reranker = keywordReranker({ weight: 1 });

    // Neither candidate shares a query term → equal lexical score 0.
    const candidates = [makeChunk("apple", 0.9, "first"), makeChunk("banana", 0.8, "second")];

    const ranked = await reranker.rerank("zebra", candidates);

    expect(ranked.map((chunk) => chunk.citation.sourceId)).toEqual(["first", "second"]);
  });

  it("returns [] for empty candidates", async () => {
    const reranker = keywordReranker();

    await expect(reranker.rerank("anything", [])).resolves.toEqual([]);
  });
});
