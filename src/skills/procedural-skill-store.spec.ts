import { MemoryCacheDriver } from "@warlock.js/cache";
import { describe, expect, it } from "vitest";
import { proceduralSkillStore } from "./store/procedural-skill-store";
import { FakeEmbedder } from "./test-support/make-skill";

/** A vector-capable cache driver wired like the memory specs do. */
function makeStore(): MemoryCacheDriver {
  const driver = new MemoryCacheDriver();
  driver.setOptions({});
  driver.setLoggingState(false);

  return driver;
}

describe("proceduralSkillStore — skills ⇄ procedural-memory unification (Phase 2)", () => {
  it("saves an inert candidate that is not listed or loaded", async () => {
    const store = proceduralSkillStore({ embedder: new FakeEmbedder(), store: makeStore() });

    const candidate = await store.saveCandidate({
      name: "deploy",
      description: "Deploy the app",
      body: "run the deploy script",
    });

    expect(candidate).toMatchObject({ name: "deploy", version: 0, type: "candidate" });
    expect(await store.list()).toEqual([]);
    expect(await store.load("deploy")).toBeUndefined();
  });

  it("promote bumps the version, flips to promoted, and reinforces (uses increments)", async () => {
    const driver = makeStore();
    const store = proceduralSkillStore({ embedder: new FakeEmbedder(), store: driver });

    await store.saveCandidate({ name: "deploy", description: "Deploy the app", body: "deploy steps" });

    const promoted = await store.promote("deploy");

    expect(promoted).toMatchObject({ name: "deploy", version: 1, type: "promoted" });

    // Now catalogued + loadable.
    const list = await store.list();
    expect(list.map((entry) => entry.name)).toEqual(["deploy"]);

    const record = await store.load("deploy");
    expect(record).toMatchObject({ name: "deploy", version: 1, type: "promoted", body: "deploy steps" });

    // Reinforcement: re-remembering the same id again (a second promote)
    // bumps the version monotonically and keeps the entry.
    const again = await store.promote("deploy");
    expect(again.version).toBe(2);
  });

  it("throws when promoting an unknown skill", async () => {
    const store = proceduralSkillStore({ embedder: new FakeEmbedder(), store: makeStore() });

    await expect(store.promote("ghost")).rejects.toThrow(/no skill named "ghost"/);
  });

  it("filters listed promoted skills by intersecting scope tags", async () => {
    const store = proceduralSkillStore({ embedder: new FakeEmbedder(), store: makeStore() });

    await store.saveCandidate({ name: "fe", description: "Frontend", body: "fe", tags: ["frontend"] });
    await store.promote("fe");
    await store.saveCandidate({ name: "be", description: "Backend", body: "be", tags: ["backend"] });
    await store.promote("be");

    const filtered = await store.list({ tags: ["frontend"] });
    expect(filtered.map((entry) => entry.name)).toEqual(["fe"]);
  });
});
