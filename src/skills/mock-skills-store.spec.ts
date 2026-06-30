import { describe, expect, it } from "vitest";
import { MockSkillsStore } from "./store/mock-skills-store";
import { makeSkill } from "./test-support/make-skill";

describe("MockSkillsStore", () => {
  it("lists and loads seeded records", async () => {
    const store = new MockSkillsStore([
      makeSkill({ name: "a", description: "Alpha", body: "A body" }),
      makeSkill({ name: "b", description: "Beta", body: "B body" }),
    ]);

    const list = await store.list();
    expect(list.map((entry) => entry.name).sort()).toEqual(["a", "b"]);
    expect((list[0] as Record<string, unknown>).body).toBeUndefined();

    const record = await store.load("a");
    expect(record).toMatchObject({ name: "a", description: "Alpha", body: "A body", version: 1 });
  });

  it("returns undefined for an unknown name or a mismatched pinned version", async () => {
    const store = new MockSkillsStore([makeSkill({ name: "a", version: 1 })]);

    expect(await store.load("missing")).toBeUndefined();
    expect(await store.load("a", 2)).toBeUndefined();
    expect(await store.load("a", 1)).toMatchObject({ name: "a" });
  });

  it("saveCandidate writes an inert, non-listable, non-loadable candidate", async () => {
    const store = new MockSkillsStore([]);

    const candidate = await store.saveCandidate({
      name: "draft",
      description: "A draft",
      body: "draft body",
    });

    expect(candidate).toMatchObject({ name: "draft", version: 0, type: "candidate" });
    expect(await store.list()).toEqual([]);
    expect(await store.load("draft")).toBeUndefined();
  });

  it("promote flips a candidate to promoted with a monotonic version bump", async () => {
    const store = new MockSkillsStore([]);
    await store.saveCandidate({ name: "draft", description: "A draft", body: "body" });

    const promoted = await store.promote("draft");

    expect(promoted).toMatchObject({ name: "draft", version: 1, type: "promoted" });

    const list = await store.list();
    expect(list.map((entry) => entry.name)).toEqual(["draft"]);

    // A second promote cycle bumps again.
    const again = await store.promote("draft");
    expect(again.version).toBe(2);
  });

  it("throws when promoting a non-existent skill", async () => {
    const store = new MockSkillsStore([]);

    await expect(store.promote("ghost")).rejects.toThrow(/no skill named "ghost"/);
  });

  it("filters list by intersecting scope tags", async () => {
    const store = new MockSkillsStore([
      makeSkill({ name: "fe", tags: ["frontend", "react"] }),
      makeSkill({ name: "be", tags: ["backend"] }),
    ]);

    const filtered = await store.list({ tags: ["react"] });
    expect(filtered.map((entry) => entry.name)).toEqual(["fe"]);
  });
});
