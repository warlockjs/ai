import { describe, expect, it } from "vitest";
import type {
  EmbedderContract,
  EmbeddingBatchResult,
  EmbeddingResult,
} from "../contracts/embedder.contract";
import { EmbeddingVectorCountMismatchError } from "../errors";
import { skills } from "./skills";
import { MockSkillsStore } from "./store/mock-skills-store";
import { FakeEmbedder, makeSkill } from "./test-support/make-skill";

describe("semantic pre-injection — preload", () => {
  it("returns [] when inject is omitted (catalog-only default)", async () => {
    const store = new MockSkillsStore([makeSkill({ name: "a", body: "A" })]);
    const lib = skills({ name: "build", sources: [{ type: "store", store }] });

    expect(await lib.preload("anything")).toEqual([]);
  });

  it("returns the topK most-similar bodies by similarity", async () => {
    // Descriptions chosen so letter-frequency cosine ranks them clearly
    // against the input.
    const store = new MockSkillsStore([
      makeSkill({ name: "react", description: "react react react", body: "REACT BODY" }),
      makeSkill({ name: "zzz", description: "zzzzzz qqqqqq", body: "ZZZ BODY" }),
    ]);

    const lib = skills({
      name: "build",
      sources: [{ type: "store", store }],
      inject: { select: "semantic", topK: 1, embedder: new FakeEmbedder() },
    });

    const records = await lib.preload("react react react react");

    expect(records).toHaveLength(1);
    expect(records[0].name).toBe("react");
    expect(records[0].body).toBe("REACT BODY");
  });

  it("applies the similarity threshold floor", async () => {
    const store = new MockSkillsStore([
      makeSkill({ name: "zzz", description: "zzzzzz qqqqqq", body: "ZZZ" }),
    ]);

    const lib = skills({
      name: "build",
      sources: [{ type: "store", store }],
      // Disjoint input vs. the only skill ⇒ low similarity ⇒ filtered by a high floor.
      inject: { select: "semantic", topK: 5, threshold: 0.99, embedder: new FakeEmbedder() },
    });

    expect(await lib.preload("aaaaaa bbbbbb")).toEqual([]);
  });

  it("rejects a provider response that leaves a skill without a vector", async () => {
    const embedder: EmbedderContract = {
      name: "short-embedder",
      provider: "short-provider",
      dimensions: 0,
      async embed(input): Promise<EmbeddingResult> {
        return new FakeEmbedder().embed(input);
      },
      async embedMany(inputs): Promise<EmbeddingBatchResult> {
        const result = await new FakeEmbedder().embedMany(inputs);

        return { ...result, vectors: result.vectors.slice(0, -1) };
      },
    };
    const store = new MockSkillsStore([
      makeSkill({ name: "first", body: "FIRST" }),
      makeSkill({ name: "missing", body: "MISSING" }),
    ]);
    const lib = skills({
      name: "build",
      sources: [{ type: "store", store }],
      inject: { select: "semantic", topK: 2, embedder },
    });

    try {
      await lib.preload("input");
      throw new Error("Expected preload() to reject a short embedding response");
    } catch (error) {
      expect(error).toBeInstanceOf(EmbeddingVectorCountMismatchError);
      if (error instanceof EmbeddingVectorCountMismatchError) {
        expect(error.provider).toBe("short-provider");
        expect(error.expectedCount).toBe(3);
        expect(error.receivedCount).toBe(2);
        expect(error.record).toBe("missing");
      }
    }
  });

  it('injects every body when inject is "all"', async () => {
    const store = new MockSkillsStore([
      makeSkill({ name: "a", body: "A" }),
      makeSkill({ name: "b", body: "B" }),
    ]);

    const lib = skills({
      name: "build",
      sources: [{ type: "store", store }],
      inject: "all",
    });

    const records = await lib.preload("ignored");

    expect(records.map((record) => record.name).sort()).toEqual(["a", "b"]);
  });

  it("throws the curated install string when a semantic embedder is missing", async () => {
    const store = new MockSkillsStore([makeSkill({ name: "a", description: "alpha", body: "A" })]);

    const lib = skills({
      name: "build",
      sources: [{ type: "store", store }],
      // No embedder supplied, and @warlock.js/ai-openai is not linked in dev.
      inject: { select: "semantic", topK: 1 },
    });

    await expect(lib.preload("alpha")).rejects.toThrow(/inject\.embedder|embedder/i);
  });
});
