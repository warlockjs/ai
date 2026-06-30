import { describe, expect, it } from "vitest";
import { skills } from "./skills";
import { MockSkillsStore } from "./store/mock-skills-store";
import { makeSkill, recordingAnalytics } from "./test-support/make-skill";

describe("catalog — progressive disclosure", () => {
  it("lists name/version/description and never the body", async () => {
    const store = new MockSkillsStore([
      makeSkill({ name: "scaffold", description: "Scaffold a form", body: "SECRET BODY" }),
    ]);

    const lib = skills({ name: "build", sources: [{ type: "store", store }] });

    const entries = await lib.catalog();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: "scaffold", version: 1, description: "Scaffold a form" });
    expect(JSON.stringify(entries)).not.toContain("SECRET BODY");
    expect((entries[0] as Record<string, unknown>).body).toBeUndefined();
  });

  it("renders the catalog prompt as one line per skill", async () => {
    const store = new MockSkillsStore([
      makeSkill({ name: "a", description: "First skill" }),
      makeSkill({ name: "b", description: "Second skill" }),
    ]);

    const lib = skills({ name: "build", sources: [{ type: "store", store }] });

    const prompt = await lib.catalogPrompt();

    expect(prompt).toContain("- a (v1): First skill");
    expect(prompt).toContain("- b (v1): Second skill");
    expect(prompt).toContain("loadSkill");
  });

  it("returns an empty prompt when no skills are in scope", async () => {
    const lib = skills({ name: "empty", sources: [{ type: "store", store: new MockSkillsStore([]) }] });

    expect(await lib.catalogPrompt()).toBe("");
  });

  it("filters the catalog by scope tags", async () => {
    const store = new MockSkillsStore([
      makeSkill({ name: "fe", tags: ["frontend"] }),
      makeSkill({ name: "be", tags: ["backend"] }),
      makeSkill({ name: "untagged" }),
    ]);

    const lib = skills({
      name: "scoped",
      sources: [{ type: "store", store }],
      scope: { tags: ["frontend"] },
    });

    const entries = await lib.catalog();

    expect(entries.map((entry) => entry.name)).toEqual(["fe"]);
  });

  it("merges multiple sources with later-source-wins precedence", async () => {
    const base = new MockSkillsStore([
      makeSkill({ name: "shared", description: "from base", version: 1 }),
      makeSkill({ name: "only-base" }),
    ]);
    const override = new MockSkillsStore([
      makeSkill({ name: "shared", description: "from override", version: 2 }),
      makeSkill({ name: "only-override" }),
    ]);

    const lib = skills({
      name: "merged",
      sources: [
        { type: "store", store: base },
        { type: "store", store: override },
      ],
    });

    const entries = await lib.catalog();
    const shared = entries.find((entry) => entry.name === "shared");

    expect(shared?.description).toBe("from override");
    expect(shared?.version).toBe(2);
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      "only-base",
      "only-override",
      "shared",
    ]);
  });

  it("fires a catalogued analytics event per skill", async () => {
    const analytics = recordingAnalytics();
    const store = new MockSkillsStore([makeSkill({ name: "x" }), makeSkill({ name: "y" })]);

    const lib = skills({
      name: "tracked",
      sources: [{ type: "store", store }],
      analytics: analytics.record,
    });

    await lib.catalog();

    const catalogued = analytics.events.filter((event) => event.type === "catalogued");
    expect(catalogued.map((event) => event.skill).sort()).toEqual(["x", "y"]);
  });

  it("excludes inert candidates from the catalog", async () => {
    const store = new MockSkillsStore([]);
    await store.saveCandidate({ name: "candidate", description: "inert", body: "nope" });

    const lib = skills({ name: "gated", sources: [{ type: "store", store }] });

    expect(await lib.catalog()).toHaveLength(0);
  });

  it("rejects a config with no sources", () => {
    expect(() => skills({ name: "bad", sources: [] })).toThrow(/at least one source/);
  });
});
