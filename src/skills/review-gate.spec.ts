import { describe, expect, it } from "vitest";
import type { SkillReviewGate } from "./contracts/skills-config.type";
import { runReviewGate } from "./review-gate";
import { skills } from "./skills";
import { MockSkillsStore } from "./store/mock-skills-store";
import { makeSkill, recordingAnalytics } from "./test-support/make-skill";

/** A candidate fixture to feed the gate. */
function candidate() {
  return makeSkill({ name: "draft", description: "A draft", body: "body", type: "candidate", version: 0 });
}

describe("review gate — default DENY (Phase 2)", () => {
  it("does not expose saveSkill when no review gate is configured", () => {
    const lib = skills({ name: "no-gate", sources: [{ type: "store", store: new MockSkillsStore([]) }] });

    const toolNames = lib.tools().map((tool) => tool.name);
    expect(toolNames).toContain("loadSkill");
    expect(toolNames).not.toContain("saveSkill");
  });

  it("exposes saveSkill only when a review gate is configured", () => {
    const store = new MockSkillsStore([]);
    const gate: SkillReviewGate = { approve: async () => ({ approve: false }), store };

    const lib = skills({
      name: "gated",
      sources: [{ type: "store", store }],
      review: gate,
    });

    expect(lib.tools().map((tool) => tool.name)).toContain("saveSkill");
  });

  it("leaves the candidate inert when approve resolves false", async () => {
    const store = new MockSkillsStore([]);
    await store.saveCandidate({ name: "draft", description: "A draft", body: "body" });

    const gate: SkillReviewGate = { approve: async () => ({ approve: false }), store };
    const outcome = await runReviewGate(candidate(), gate);

    expect(outcome.promoted).toBe(false);
    expect(await store.load("draft")).toBeUndefined();
  });

  it("treats a throwing gate as a denial (fail-closed)", async () => {
    const store = new MockSkillsStore([]);
    await store.saveCandidate({ name: "draft", description: "A draft", body: "body" });

    const gate: SkillReviewGate = {
      approve: async () => {
        throw new Error("validator exploded");
      },
      store,
    };

    const outcome = await runReviewGate(candidate(), gate);

    expect(outcome.promoted).toBe(false);
    expect(await store.load("draft")).toBeUndefined();
  });

  it("promotes with a version bump + analytics when approve resolves true", async () => {
    const analytics = recordingAnalytics();
    const store = new MockSkillsStore([]);
    await store.saveCandidate({ name: "draft", description: "A draft", body: "body" });

    const gate: SkillReviewGate = { approve: async () => ({ approve: true }), store };

    const outcome = await runReviewGate(candidate(), gate, analytics.record);

    expect(outcome.promoted).toBe(true);
    if (outcome.promoted) {
      expect(outcome.record).toMatchObject({ name: "draft", version: 1, type: "promoted" });
    }

    // Now catalogued + loadable.
    expect(await store.load("draft")).toMatchObject({ type: "promoted", version: 1 });
    expect(analytics.events.find((event) => event.type === "promoted")).toMatchObject({
      skill: "draft",
      version: 1,
    });
  });

  it("emits a denied analytics event when not approved", async () => {
    const analytics = recordingAnalytics();
    const store = new MockSkillsStore([]);
    const gate: SkillReviewGate = { approve: async () => ({ approve: false }), store };

    await runReviewGate(candidate(), gate, analytics.record);

    expect(analytics.events.find((event) => event.type === "denied")).toMatchObject({ skill: "draft" });
  });
});
