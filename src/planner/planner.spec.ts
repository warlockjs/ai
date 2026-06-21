import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import type { PlannerPlan } from "../contracts/planner/planner-plan.type";
import { PlannerCancelledError } from "../errors/planner-cancelled-error";
import { PlannerFailedError } from "../errors/planner-failed-error";
import { PlannerPlanInvalidError } from "../errors/planner-plan-invalid-error";
import { mockAgent } from "../mock/mock-agent";
import { MockModel } from "../mock/mock-model";
import { MockSDK } from "../mock/mock-sdk";
import { agent } from "../agent/agent";
import { instruction } from "../system-prompt/instruction";
import { systemPrompt } from "../system-prompt/system-prompt";
import { planner } from "./planner";

/**
 * Build a planning agent whose single trip returns `plan` as JSON — the
 * shape the planner's plan schema expects.
 */
function planningAgent(plan: PlannerPlan) {
  const sdk = MockSDK({
    responses: [{ content: JSON.stringify(plan), finishReason: "stop" }],
  });

  return agent({ name: "byo-planner", model: sdk.model({ name: "mock-planner" }) });
}

function planModel(plan: PlannerPlan) {
  return MockSDK({
    responses: [{ content: JSON.stringify(plan), finishReason: "stop" }],
  }).model({ name: "mock-planner" });
}

describe("ai.planner — authoring validation", () => {
  it("throws when name is missing", () => {
    expect(() =>
      planner({
        name: "",
        model: planModel({ steps: [] }),
        capabilities: [
          { name: "a", description: "d", executable: mockAgent({ name: "a" }) },
        ],
      }),
    ).toThrow(PlannerFailedError);
  });

  it("throws when neither model nor planner is supplied", () => {
    expect(() =>
      planner({
        name: "p",
        capabilities: [
          { name: "a", description: "d", executable: mockAgent({ name: "a" }) },
        ],
      } as never),
    ).toThrow(/one of `model` or `planner`/);
  });

  it("throws when both model and planner are supplied", () => {
    expect(() =>
      planner({
        name: "p",
        model: planModel({ steps: [] }),
        planner: mockAgent({ name: "byo" }),
        capabilities: [
          { name: "a", description: "d", executable: mockAgent({ name: "a" }) },
        ],
      }),
    ).toThrow(/mutually exclusive/);
  });

  it("throws when no capabilities are given", () => {
    expect(() =>
      planner({ name: "p", model: planModel({ steps: [] }), capabilities: [] }),
    ).toThrow(/at least one capability/);
  });

  it("throws on a duplicate capability name", () => {
    expect(() =>
      planner({
        name: "p",
        model: planModel({ steps: [] }),
        capabilities: [
          { name: "a", description: "d", executable: mockAgent({ name: "a1" }) },
          { name: "a", description: "d", executable: mockAgent({ name: "a2" }) },
        ],
      }),
    ).toThrow(/duplicate capability/);
  });

  it("throws when maxSteps < 1", () => {
    expect(() =>
      planner({
        name: "p",
        model: planModel({ steps: [] }),
        maxSteps: 0,
        capabilities: [
          { name: "a", description: "d", executable: mockAgent({ name: "a" }) },
        ],
      }),
    ).toThrow(/`maxSteps` must be >= 1/);
  });

  it("exposes name and a stable signature", () => {
    const instance = planner({
      name: "research",
      model: planModel({ steps: [] }),
      capabilities: [
        { name: "search", description: "Search the web", executable: mockAgent({ name: "s" }) },
        { name: "write", description: "Draft a summary", executable: mockAgent({ name: "w" }) },
      ],
    });

    expect(instance.name).toBe("research");
    expect(instance.signature).toContain("planner:research");
    expect(instance.signature).toContain(`search${String.fromCharCode(0)}write`);
  });
});

describe("ai.planner — plan generation + execution", () => {
  it("generates a plan and executes its steps in order", async () => {
    const search = mockAgent({
      name: "search",
      responses: [{ content: "found three articles", finishReason: "stop" }],
    });
    const write = mockAgent({
      name: "write",
      responses: [{ content: "final summary", finishReason: "stop" }],
    });

    const plan: PlannerPlan = {
      summary: "search then write",
      steps: [
        { capability: "search", input: "find articles about X" },
        { capability: "write", input: "summarize the findings" },
      ],
    };

    const research = planner({
      name: "research",
      model: planModel(plan),
      capabilities: [
        { name: "search", description: "Search the web", executable: search },
        { name: "write", description: "Draft a summary", executable: write },
      ],
    });

    const result = await research.execute("Research X");

    expect(result.type).toBe("planner");
    expect(result.error).toBeUndefined();
    expect(result.report.type).toBe("planner");
    expect(result.report.status).toBe("completed");
    expect(result.report.plan?.summary).toBe("search then write");
    expect(result.report.executedSteps).toHaveLength(2);
    expect(result.report.executedSteps.map((entry) => entry.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(result.report.executedSteps[0].step.capability).toBe("search");
    expect(result.report.executedSteps[1].step.capability).toBe("write");
    // Final step output flows into data.
    expect(result.data).toBe("final summary");
  });

  it("threads each step's output into the next step's input context", async () => {
    const search = mockAgent({
      name: "search",
      responses: [{ content: "ARTICLE-A", finishReason: "stop" }],
    });
    const writeModel = MockSDK({
      responses: [{ content: "drafted", finishReason: "stop" }],
    }).model({ name: "w" }) as MockModel;
    const write = agent({ name: "write", model: writeModel });

    const plan: PlannerPlan = {
      steps: [
        { capability: "search", input: "find" },
        { capability: "write", input: "compose" },
      ],
    };

    const instance = planner({
      name: "chain",
      model: planModel(plan),
      capabilities: [
        { name: "search", description: "search", executable: search },
        { name: "write", description: "write", executable: write },
      ],
    });

    await instance.execute("go");

    // The writer agent's user message must carry the prior step output.
    const messages = writeModel.callHistory[0]?.messages ?? [];
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain("ARTICLE-A");
    expect(serialized).toContain("compose");
  });

  it("rolls up usage and child reports from every executed step", async () => {
    const a = mockAgent({
      name: "a",
      responses: [
        { content: "out-a", finishReason: "stop", usage: { input: 5, output: 3, total: 8 } },
      ],
    });
    const b = mockAgent({
      name: "b",
      responses: [
        { content: "out-b", finishReason: "stop", usage: { input: 7, output: 2, total: 9 } },
      ],
    });

    const plan: PlannerPlan = {
      steps: [
        { capability: "a", input: "1" },
        { capability: "b", input: "2" },
      ],
    };

    const instance = planner({
      name: "rollup",
      model: planModel(plan),
      capabilities: [
        { name: "a", description: "a", executable: a },
        { name: "b", description: "b", executable: b },
      ],
    });

    const result = await instance.execute("go");

    // children: the planning agent + the two step agents.
    expect(result.report.children.length).toBeGreaterThanOrEqual(3);
    // every child shares this run's root id (lineage stamped).
    for (const child of result.report.children) {
      expect(child.rootRunId).toBe(result.report.runId);
    }
    // usage is a positive rollup including step + planning costs.
    expect(result.usage.total).toBeGreaterThan(0);
  });

  it("forwards execute() placeholders into the planning agent's prompt", async () => {
    // The planning agent's system prompt carries a `{{topic}}` slot;
    // the only way "React" reaches the rendered system message is if the
    // planner forwards `options.placeholders` into the planning trip.
    const planModelInstance = MockSDK({
      responses: [
        {
          content: JSON.stringify({ steps: [{ capability: "search", input: "go" }] }),
          finishReason: "stop",
        },
      ],
    }).model({ name: "planner-model" }) as MockModel;

    const planningAgentWithPlaceholder = agent({
      name: "byo-planner",
      model: planModelInstance,
      systemPrompt: systemPrompt().instruction(instruction("Plan research about {{topic}}.")),
    });

    const search = mockAgent({
      name: "search",
      responses: [{ content: "found", finishReason: "stop" }],
    });

    const instance = planner({
      name: "with-placeholders",
      planner: planningAgentWithPlaceholder,
      capabilities: [{ name: "search", description: "search", executable: search }],
    });

    await instance.execute("Research the topic", { placeholders: { topic: "React" } });

    const planningMessages = planModelInstance.callHistory[0]?.messages ?? [];
    const systemMessage = planningMessages.find((message) => message.role === "system");
    expect(JSON.stringify(systemMessage?.content)).toContain("React");
  });
});

describe("ai.planner — failure paths", () => {
  it("fails when the generated plan has no steps", async () => {
    const instance = planner({
      name: "empty",
      model: planModel({ steps: [] }),
      capabilities: [{ name: "a", description: "a", executable: mockAgent({ name: "a" }) }],
    });

    const result = await instance.execute("go");

    // An empty plan trips the plan schema inside the planning agent
    // (raw SchemaValidationError); the planner re-wraps that into the
    // typed PlannerPlanInvalidError so callers branch on one contract.
    expect(result.error).toBeInstanceOf(PlannerPlanInvalidError);
    expect(result.error?.code).toBe("PLANNER_PLAN_INVALID");
    expect(result.report.status).toBe("failed");
    expect(result.data).toBeUndefined();
    expect(result.report.executedSteps).toHaveLength(0);
  });

  it("fails with PlannerPlanInvalidError when a step names an unknown capability", async () => {
    const plan: PlannerPlan = { steps: [{ capability: "ghost", input: "x" }] };

    const instance = planner({
      name: "ghost-ref",
      model: planModel(plan),
      capabilities: [{ name: "a", description: "a", executable: mockAgent({ name: "a" }) }],
    });

    const result = await instance.execute("go");

    expect(result.error).toBeInstanceOf(PlannerPlanInvalidError);
    expect(result.error?.code).toBe("PLANNER_PLAN_INVALID");
  });

  it("stops at the first failed step and marks the rest skipped", async () => {
    const sdk = MockSDK({
      responses: [{ content: "boom", finishReason: "stop", error: new Error("nope") }],
    });
    const failing = agent({ name: "failing", model: sdk.model({ name: "f" }) });
    const never = mockAgent({ name: "never" });

    const plan: PlannerPlan = {
      steps: [
        { capability: "failing", input: "1" },
        { capability: "never", input: "2" },
      ],
    };

    const instance = planner({
      name: "stop-on-fail",
      model: planModel(plan),
      capabilities: [
        { name: "failing", description: "fails", executable: failing },
        { name: "never", description: "skipped", executable: never },
      ],
    });

    const result = await instance.execute("go");

    expect(result.report.status).toBe("failed");
    expect(result.report.executedSteps).toHaveLength(2);
    expect(result.report.executedSteps[0].status).toBe("failed");
    expect(result.report.executedSteps[1].status).toBe("skipped");
    expect(result.error).toBeDefined();
  });

  it("truncates plan steps beyond maxSteps as skipped", async () => {
    const a = mockAgent({ name: "a", responses: [{ content: "ok", finishReason: "stop" }] });

    const plan: PlannerPlan = {
      steps: [
        { capability: "a", input: "1" },
        { capability: "a", input: "2" },
        { capability: "a", input: "3" },
      ],
    };

    const instance = planner({
      name: "capped",
      model: planModel(plan),
      maxSteps: 1,
      capabilities: [{ name: "a", description: "a", executable: a }],
    });

    const result = await instance.execute("go");

    expect(result.report.executedSteps[0].status).toBe("completed");
    expect(result.report.executedSteps[1].status).toBe("skipped");
    expect(result.report.executedSteps[2].status).toBe("skipped");
  });
});

describe("ai.planner — cancellation", () => {
  it("returns cancelled when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort("user pressed stop");

    const instance = planner({
      name: "cancel",
      model: planModel({ steps: [{ capability: "a", input: "1" }] }),
      capabilities: [{ name: "a", description: "a", executable: mockAgent({ name: "a" }) }],
    });

    const result = await instance.execute("go", { signal: controller.signal });

    expect(result.report.status).toBe("cancelled");
    expect(result.error).toBeInstanceOf(PlannerCancelledError);
    expect(result.report.cancelledAt).toBeDefined();
  });
});

describe("ai.planner — output schema + bring-your-own planner", () => {
  it("validates the final output against the configured schema", async () => {
    const schema: StandardSchemaV1<{ text: string }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate(value: unknown) {
          const record = value as { text?: unknown };
          if (typeof record?.text === "string") {
            return { value: { text: record.text } };
          }
          return { issues: [{ message: "text required" }] };
        },
      },
    };

    // The final capability emits structured data via its own output
    // schema — that structured `data` is what the planner validates.
    const upperModel = MockSDK({
      responses: [{ content: '{"text":"DONE"}', finishReason: "stop" }],
    }).model({ name: "u" });
    const upper = agent({ name: "upper", model: upperModel, output: schema });

    const instance = planner<{ text: string }>({
      name: "typed",
      model: planModel({ steps: [{ capability: "upper", input: "x" }] }),
      capabilities: [{ name: "upper", description: "upper", executable: upper }],
      output: schema,
    });

    const result = await instance.execute("go");

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ text: "DONE" });
  });

  it("fails when an output schema is set but the last step produced no output", async () => {
    const schema: StandardSchemaV1<{ text: string }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate(value: unknown) {
          const record = value as { text?: unknown };
          if (typeof record?.text === "string") {
            return { value: { text: record.text } };
          }
          return { issues: [{ message: "text required" }] };
        },
      },
    };

    // A capability that completes successfully but yields neither
    // structured `data` nor `text` — so the planner has nothing to feed
    // the configured `output` schema. Previously this returned
    // { data: undefined, error: undefined, status: "completed" }.
    const silent = {
      name: "silent",
      execute: async () => ({ usage: { input: 0, output: 0, total: 0 } }),
    };

    const instance = planner<{ text: string }>({
      name: "no-output",
      model: planModel({ steps: [{ capability: "silent", input: "x" }] }),
      capabilities: [{ name: "silent", description: "produces nothing", executable: silent }],
      output: schema,
    });

    const result = await instance.execute("go");

    expect(result.error).toBeInstanceOf(PlannerPlanInvalidError);
    expect(result.error?.code).toBe("PLANNER_PLAN_INVALID");
    expect(result.error?.message).toMatch(/without producing output/);
    expect(result.report.status).toBe("failed");
    expect(result.data).toBeUndefined();
  });

  it("accepts a bring-your-own planner agent", async () => {
    const search = mockAgent({
      name: "search",
      responses: [{ content: "results", finishReason: "stop" }],
    });

    const plan: PlannerPlan = { steps: [{ capability: "search", input: "find" }] };

    const instance = planner({
      name: "byo",
      planner: planningAgent(plan),
      capabilities: [{ name: "search", description: "search", executable: search }],
    });

    const result = await instance.execute("go");

    expect(result.report.status).toBe("completed");
    expect(result.report.plan?.steps).toHaveLength(1);
  });
});

describe("ai.planner — error categories", () => {
  it("PlannerFailedError carries a sensible default category", () => {
    expect(new PlannerFailedError("x").category).toBe("provider");
  });

  it("PlannerPlanInvalidError is category \"schema\"", () => {
    expect(new PlannerPlanInvalidError("x").category).toBe("schema");
  });

  it("PlannerCancelledError is category \"cancelled\"", () => {
    expect(new PlannerCancelledError("x", { cancelledAt: "t" }).category).toBe("cancelled");
  });
});
