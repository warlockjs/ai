import { describe, expect, it } from "vitest";
import type { ToolContract } from "../tool/tool";
import type { LoadSkillResult } from "./load-skill-tool";
import { skills } from "./skills";
import type { SkillsContract } from "./contracts/skills.contract";
import { MockSkillsStore } from "./store/mock-skills-store";
import { makeSkill, recordingAnalytics } from "./test-support/make-skill";

/** Pull a named tool out of a library's tool list, narrowed to a ToolContract. */
function toolNamed(lib: SkillsContract, runId: string, name: string): ToolContract<any, any> {
  const tool = lib.tools(runId).find((entry) => entry.name === name);

  if (!tool || typeof (tool as ToolContract).invoke !== "function") {
    throw new Error(`${name} tool not found`);
  }

  return tool as ToolContract<any, any>;
}

/** Pull the single `loadSkill` tool out of a freshly built library. */
function loadTool(store: MockSkillsStore, runId = "run-1", maxLoadsPerRun?: number): ToolContract<any, any> {
  const lib = skills({
    name: "build",
    sources: [{ type: "store", store }],
    ...(maxLoadsPerRun !== undefined ? { maxLoadsPerRun } : {}),
  });

  return toolNamed(lib, runId, "loadSkill");
}

describe("loadSkill tool", () => {
  it("returns the skill body as the tool result", async () => {
    const store = new MockSkillsStore([makeSkill({ name: "scaffold", body: "FULL BODY" })]);
    const tool = loadTool(store);

    const result = await tool.invoke({ name: "scaffold" });
    const data = result.data as LoadSkillResult;

    expect(result.error).toBeUndefined();
    expect(data).toMatchObject({ body: "FULL BODY", name: "scaffold", version: 1 });
  });

  it("returns an error result for an unknown skill, not a throw", async () => {
    const tool = loadTool(new MockSkillsStore([]));

    const result = await tool.invoke({ name: "missing" });
    const data = result.data as LoadSkillResult;

    expect(result.error).toBeUndefined();
    expect(data).toEqual({ error: "unknown skill: missing" });
  });

  it("returns an error result once maxLoadsPerRun is exhausted", async () => {
    const store = new MockSkillsStore([
      makeSkill({ name: "a", body: "A" }),
      makeSkill({ name: "b", body: "B" }),
      makeSkill({ name: "c", body: "C" }),
    ]);
    const tool = loadTool(store, "run-1", 2);

    const first = (await tool.invoke({ name: "a" })).data as LoadSkillResult;
    const second = (await tool.invoke({ name: "b" })).data as LoadSkillResult;
    const third = (await tool.invoke({ name: "c" })).data as LoadSkillResult;

    expect(first).toMatchObject({ body: "A" });
    expect(second).toMatchObject({ body: "B" });
    expect(third).toEqual({ error: "skill load budget exhausted" });
  });

  it("scopes the budget counter per tool instance (per run)", async () => {
    const store = new MockSkillsStore([makeSkill({ name: "a", body: "A" })]);
    const lib = skills({ name: "build", sources: [{ type: "store", store }], maxLoadsPerRun: 1 });

    const toolRun1 = toolNamed(lib, "run-1", "loadSkill");
    const toolRun2 = toolNamed(lib, "run-2", "loadSkill");

    // Exhaust run-1's budget.
    await toolRun1.invoke({ name: "a" });
    const run1Exhausted = (await toolRun1.invoke({ name: "a" })).data as LoadSkillResult;
    // run-2 has its own fresh budget.
    const run2First = (await toolRun2.invoke({ name: "a" })).data as LoadSkillResult;

    expect(run1Exhausted).toEqual({ error: "skill load budget exhausted" });
    expect(run2First).toMatchObject({ body: "A" });
  });

  it("rejects malformed input via the standard schema", async () => {
    const tool = loadTool(new MockSkillsStore([makeSkill({ name: "a" })]));

    const result = await tool.invoke({ notName: 1 });

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain("loadSkill input must be");
  });

  it("fires a loaded analytics event carrying the runId", async () => {
    const analytics = recordingAnalytics();
    const store = new MockSkillsStore([makeSkill({ name: "a", body: "A" })]);

    const lib = skills({
      name: "build",
      sources: [{ type: "store", store }],
      analytics: analytics.record,
    });

    const tool = toolNamed(lib, "run-42", "loadSkill");

    await tool.invoke({ name: "a" });

    const loaded = analytics.events.find((event) => event.type === "loaded");
    expect(loaded).toMatchObject({ skill: "a", runId: "run-42" });
  });
});
