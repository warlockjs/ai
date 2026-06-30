import { describe, expect, it } from "vitest";
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

  it("injects every body when inject is \"all\"", async () => {
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
