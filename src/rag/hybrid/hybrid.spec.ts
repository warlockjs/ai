import { describe, expect, it } from "vitest";
import type { ModelContract, ModelResponse } from "../../contracts/model.contract";
import { bm25Rank } from "./bm25";
import { hybridRank } from "./hybrid-rank";
import { reciprocalRankFusion } from "./rrf";
import { multiQuery } from "../transforms/multi-query";

describe("reciprocalRankFusion (A4)", () => {
  it("ranks an id appearing high in multiple lists above single-list ids", () => {
    const fused = reciprocalRankFusion([
      ["a", "b", "c"],
      ["b", "a", "d"],
    ]);
    // `b` is rank 1 + rank 0; `a` is rank 0 + rank 1 — `a` and `b` lead.
    expect(fused.slice(0, 2).map(r => r.id).sort()).toEqual(["a", "b"]);
    expect(fused.map(r => r.id)).toContain("c");
    expect(fused.map(r => r.id)).toContain("d");
  });

  it("returns [] for no lists", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
  });
});

describe("bm25Rank (A4)", () => {
  it("ranks the document with the rare query term highest", () => {
    const docs = [
      { id: "1", text: "the cat sat on the mat" },
      { id: "2", text: "refund for invoice 8842 was processed" },
      { id: "3", text: "the weather is nice today" },
    ];
    const ranked = bm25Rank("invoice 8842 refund", docs);
    expect(ranked[0].id).toBe("2");
  });

  it("returns [] when no query term matches", () => {
    expect(bm25Rank("zzz", [{ id: "1", text: "hello world" }])).toEqual([]);
  });
});

describe("hybridRank (A4)", () => {
  it("fuses a dense ranking with a lexical match the vectors missed", () => {
    // Dense ranking puts the semantically-fuzzy doc first; the exact-term
    // doc is lower. BM25 boosts the exact match; fusion lifts it.
    const dense = [{ id: "fuzzy" }, { id: "exact" }, { id: "other" }];
    const candidates = [
      { id: "fuzzy", text: "general help with billing questions" },
      { id: "exact", text: "invoice 8842 refund status" },
      { id: "other", text: "weather report" },
    ];

    const fused = hybridRank({ query: "invoice 8842", dense, candidates });
    // The exact lexical match should rank at or near the top after fusion.
    expect(fused[0].id).toBe("exact");
  });
});

class FakeModel implements ModelContract {
  public readonly name = "m";
  public readonly provider = "p";
  public constructor(private readonly text: string) {}
  public async complete(): Promise<ModelResponse> {
    return { content: this.text, finishReason: "stop", usage: { input: 1, output: 1, total: 2 } };
  }
  public async *stream(): AsyncIterable<never> {
    /* unused */
  }
}

describe("multiQuery (A4)", () => {
  it("returns the original plus parsed variants, de-duplicated", async () => {
    const model = new FakeModel("- cancel my subscription\n- end my plan\n- how to unsubscribe");
    const queries = await multiQuery(model, "how do I cancel?", { n: 3 });

    expect(queries[0]).toBe("how do I cancel?");
    expect(queries).toContain("cancel my subscription");
    expect(queries).toContain("end my plan");
    expect(queries.length).toBe(4);
  });

  it("can omit the original query", async () => {
    const model = new FakeModel("alpha\nbeta");
    const queries = await multiQuery(model, "orig", { n: 2, includeOriginal: false });
    expect(queries).toEqual(["alpha", "beta"]);
  });
});
