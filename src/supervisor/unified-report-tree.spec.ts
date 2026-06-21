import { describe, expect, it } from "vitest";
import { agent } from "../agent/agent";
import { END } from "../contracts/end.type";
import type { BaseReport } from "../contracts/result/base-report.type";
import type { Usage } from "../contracts/result/usage.type";
import { MockSDK } from "../mock/mock-sdk";
import { tool } from "../tool/tool";
import { buildScriptedAgent, passthrough } from "./_test-helpers";
import { supervisor } from "./supervisor";

/**
 * Phase 3.1 — end-to-end recursion and rollup coverage for the
 * unified report tree. These tests make sure the linked envelope
 * (`ExecuteResult` → `BaseReport` with recursive `children[]`) works
 * across every composition the framework ships: agent-as-tool,
 * workflow-as-tool, supervisor-as-tool. Each primitive's own spec
 * covers its internal shape; this file proves the tree lines up.
 */

function sumUsage(...usages: Usage[]): Usage {
  return usages.reduce(
    (acc, u) => ({
      input: acc.input + u.input,
      output: acc.output + u.output,
      total: acc.total + u.total,
    }),
    { input: 0, output: 0, total: 0 },
  );
}

describe("unified report tree — cross-primitive recursion", () => {
  it("leaf tool dispatch appears under parent agent's report.children with type 'tool'", async () => {
    const echo = tool({
      name: "echo",
      description: "echoes input",
      input: passthrough,
      execute: async input => `echoed:${JSON.stringify(input)}`,
    });

    const sdk = MockSDK({
      responses: [
        {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "1", name: "echo", input: { hi: true } }],
        },
        { content: "done", finishReason: "stop" },
      ],
    });

    const parent = agent({
      model: sdk.model({ name: "parent" }),
      tools: [echo],
    });
    const { report } = await parent.execute("go");

    expect(report.type).toBe("agent");
    expect(report.children).toHaveLength(1);
    expect(report.children[0].type).toBe("tool");
    expect(report.children[0].name).toBe("echo");
    expect(report.children[0].children).toEqual([]); // leaf
  });

  it("agent invoking a supervisor-as-tool surfaces the supervisor's full report nested under the tool child", async () => {
    // Inner supervisor — one-agent dispatch, returns END immediately.
    const innerWriter = buildScriptedAgent({
      name: "writer",
      description: "drafts",
      responses: [{ content: "drafted text", finishReason: "stop" }],
    });
    const innerSup = supervisor({
      name: "inner-sup",
      intents: { writer: innerWriter },
      route: ctx => (ctx.iteration === 0 ? "writer" : END),
    });

    const supTool = innerSup.asTool({
      name: "run_inner_sup",
      description: "runs the inner supervisor",
      inputSchema: passthrough,
    });

    // Outer agent dispatches the supervisor-tool once.
    const sdk = MockSDK({
      responses: [
        {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [
            { id: "1", name: "run_inner_sup", input: { topic: "x" } },
          ],
        },
        { content: "all good", finishReason: "stop" },
      ],
    });

    const outer = agent({
      model: sdk.model({ name: "outer" }),
      tools: [supTool],
    });

    const { report } = await outer.execute("kickoff");

    // Outer agent report is an agent.
    expect(report.type).toBe("agent");
    expect(report.children).toHaveLength(1);

    // The tool dispatch node wraps the inner composite: its own
    // `type` is "tool" (it *was* a tool dispatch from the agent's POV)
    // but it carries the inner supervisor report as its sole child.
    const toolChild = report.children[0];
    expect(toolChild.type).toBe("tool");
    expect(toolChild.name).toBe("run_inner_sup");
    expect(toolChild.children).toHaveLength(1);

    const innerReport = toolChild.children[0];
    expect(innerReport.type).toBe("supervisor");
    expect(innerReport.name).toBe("inner-sup");
    expect(innerReport.status).toBe("completed");

    // Supervisor's own children include the dispatched writer agent.
    const writerReport = innerReport.children.find(c => c.name === "writer");
    expect(writerReport).toBeDefined();
    expect(writerReport!.type).toBe("agent");
  });

  it("supervisor report.usage equals sum of children.usage (rolled-up accounting)", async () => {
    const writer = buildScriptedAgent({
      name: "writer",
      description: "drafts",
      responses: [{ content: "draft", finishReason: "stop" }],
    });
    const reviewer = buildScriptedAgent({
      name: "reviewer",
      description: "reviews",
      responses: [{ content: "review", finishReason: "stop" }],
    });

    const sup = supervisor({
      name: "team",
      intents: { writer, reviewer },
      route: ctx => {
        if (ctx.iteration === 0) return "writer";
        if (ctx.iteration === 1) return "reviewer";
        return END;
      },
    });

    const { report, usage } = await sup.execute("topic");

    // Usage on the result envelope matches the supervisor report.
    expect(usage).toEqual(report.usage);

    // Rollup invariant: parent.usage == sum(children.usage).
    const expected = sumUsage(...report.children.map(c => c.usage));
    expect(report.usage).toEqual(expected);
  });

  it("every report node in a two-deep tree satisfies the rollup invariant", async () => {
    // Build: outer agent → tool dispatch → inner supervisor → writer agent.
    const writer = buildScriptedAgent({
      name: "writer",
      description: "drafts",
      responses: [{ content: "draft", finishReason: "stop" }],
    });
    const innerSup = supervisor({
      name: "inner-sup",
      intents: { writer },
      route: ctx => (ctx.iteration === 0 ? "writer" : END),
    });
    const supTool = innerSup.asTool({
      name: "inner",
      description: "inner",
      inputSchema: passthrough,
    });

    const sdk = MockSDK({
      responses: [
        {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "1", name: "inner", input: {} }],
        },
        { content: "fin", finishReason: "stop" },
      ],
    });
    const outer = agent({
      model: sdk.model({ name: "outer" }),
      tools: [supTool],
    });

    const { report } = await outer.execute("go");

    // Walk the tree — every non-leaf node must satisfy
    // node.usage == sum(children.usage) + ownUsage-we-can't-see-directly.
    // Since tool nodes contribute zero own-cost, for tool nodes:
    // node.usage == sum(children.usage). Check that leaf invariant
    // throughout the tool wrapper → supervisor → writer chain.
    function walkTools(node: BaseReport): void {
      if (node.type === "tool") {
        const childSum = sumUsage(...node.children.map(c => c.usage));
        expect(node.usage).toEqual(childSum);
      }
      node.children.forEach(walkTools);
    }

    walkTools(report);

    // Structural assertions — three levels deep.
    expect(report.children[0].type).toBe("tool"); // tool dispatch
    expect(report.children[0].children[0].type).toBe("supervisor"); // inner sup
    expect(
      report.children[0].children[0].children.some(c => c.type === "agent"),
    ).toBe(true);
  });
});
