import { describe, expect, it } from "vitest";
import { agent } from "../agent/agent";
import { END } from "../contracts/end.type";
import type { BaseReport } from "../contracts/result/base-report.type";
import type { Usage } from "../contracts/result/usage.type";
import { ai } from "../ai";
import { MockSDK } from "../mock/mock-sdk";
import { tool } from "../tool/tool";
import { passthrough } from "./_test-helpers";
import { supervisor } from "./supervisor";

/**
 * Auto-nesting of agents invoked DIRECTLY inside an orchestration
 * intent's `run()` callback — the trace-tree fix.
 *
 * Before this fix, a callback that called `agent.execute()` directly
 * (rather than `ctx.run(agent)` / `ctx.intents.X.execute()`) produced a
 * lone `callback` span with no children: the agent ran as a SEPARATE
 * top-level execution, so panoptic showed no sub-agents/tools under it
 * and cost rolled up to $0. An ambient `RunFrame` (async-local) now lets
 * the agent self-attach to the enclosing callback's `children[]`, so the
 * supervisor/orchestrator/team report tree contains
 * `callback → agent → tool` nested with usage/cost rolled up — no manual
 * id threading by the dev.
 */

const USAGE: Usage = { input: 10, output: 5, total: 15 };

/** Sum the `usage` of every report in `nodes`. */
function sumUsage(nodes: ReadonlyArray<BaseReport>): Usage {
  return nodes.reduce<Usage>(
    (acc, node) => ({
      input: acc.input + node.usage.input,
      output: acc.output + node.usage.output,
      total: acc.total + node.usage.total,
    }),
    { input: 0, output: 0, total: 0 },
  );
}

/** Depth-first search for the first node satisfying `predicate`. */
function find(
  node: BaseReport,
  predicate: (node: BaseReport) => boolean,
): BaseReport | undefined {
  if (predicate(node)) {
    return node;
  }

  for (const child of node.children) {
    const hit = find(child, predicate);

    if (hit) {
      return hit;
    }
  }

  return undefined;
}

/**
 * Build a fresh agent that calls one tool then answers — scripted via
 * `MockSDK` so every run is deterministic and carries non-zero usage so
 * cost-rollup is observable. A NEW agent per call keeps the mock
 * response queue isolated across the multiple primitives this suite
 * exercises.
 */
function buildAgentWithTool(name: string) {
  const echo = tool({
    name: "echo",
    description: "echoes input",
    input: passthrough,
    execute: async (input) => `echoed:${JSON.stringify(input)}`,
  });

  const sdk = MockSDK({
    responses: [
      {
        content: "",
        finishReason: "tool_calls",
        usage: USAGE,
        toolCalls: [{ id: "1", name: "echo", input: { hi: true } }],
      },
      { content: "done", finishReason: "stop", usage: USAGE },
    ],
  });

  return agent({ name, model: sdk.model({ name: `${name}-model` }), tools: [echo] });
}

describe("auto-nest agents invoked inside an intent callback", () => {
  it("supervisor: callback that calls agent.execute() directly nests agent → tool under the callback span with usage rolled up", async () => {
    const worker = buildAgentWithTool("worker");

    const sup = supervisor({
      name: "nesting-sup",
      intents: {
        // Callback intent: the dev calls `agent.execute(...)` DIRECTLY,
        // NOT via `ctx.run(...)` / `ctx.intents`. The ambient frame must
        // still capture the agent's report under this callback node.
        delegate: async (ctx) => {
          const result = await worker.execute(String(ctx.input));
          return { reply: result.text };
        },
      },
      route: (ctx) => (ctx.iteration === 0 ? "delegate" : END),
    });

    const { report } = await sup.execute("go");

    expect(report.type).toBe("supervisor");

    // The callback span exists and is NOT a childless leaf anymore.
    const callbackNode = find(report, (n) => n.type === "callback" && n.name === "delegate");
    expect(callbackNode).toBeDefined();
    expect(callbackNode!.children.length).toBeGreaterThan(0);

    // agent nested directly under the callback.
    const agentNode = callbackNode!.children.find((c) => c.type === "agent");
    expect(agentNode).toBeDefined();
    expect(agentNode!.name).toBe("worker");

    // tool nested under the agent.
    const toolNode = agentNode!.children.find((c) => c.type === "tool");
    expect(toolNode).toBeDefined();
    expect(toolNode!.name).toBe("echo");

    // Lineage: the agent's report was relinked to the supervisor root
    // and parented to the callback node (the outer terminal stamp pass
    // makes this authoritative across the whole tree).
    expect(agentNode!.rootRunId).toBe(report.runId);
    expect(agentNode!.parentRunId).toBe(callbackNode!.runId);

    // Cost rolled up: the agent's usage is non-zero and flows up through
    // the callback into the supervisor total (instead of $0).
    expect(agentNode!.usage.total).toBeGreaterThan(0);
    expect(callbackNode!.usage).toEqual(sumUsage(callbackNode!.children));
    expect(report.usage.total).toBeGreaterThanOrEqual(agentNode!.usage.total);
  });

  it("supervisor: ctx.run(agent) is captured exactly once (no double-count with the ambient frame)", async () => {
    const worker = buildAgentWithTool("worker-explicit");

    const sup = supervisor({
      name: "explicit-sup",
      intents: {
        delegate: async (ctx) => {
          // Explicit capture path — must NOT also self-capture via the
          // ambient frame (which would push the report twice).
          const result = await ctx.run(worker, String(ctx.input));
          return { reply: result.text };
        },
      },
      route: (ctx) => (ctx.iteration === 0 ? "delegate" : END),
    });

    const { report } = await sup.execute("go");

    const callbackNode = find(report, (n) => n.type === "callback" && n.name === "delegate");
    expect(callbackNode).toBeDefined();

    const agentNodes = callbackNode!.children.filter((c) => c.type === "agent");
    expect(agentNodes).toHaveLength(1);

    // Rollup still holds with exactly one captured agent.
    expect(callbackNode!.usage).toEqual(sumUsage(callbackNode!.children));
  });

  it("team: a member's callback that calls agent.execute() directly nests agent → tool under the member span", async () => {
    const worker = buildAgentWithTool("team-worker");

    let dispatched = false;

    const team = ai.team({
      name: "nesting-team",
      manager: {
        route: () => {
          if (!dispatched) {
            dispatched = true;
            return "builder";
          }

          return END;
        },
      },
      members: {
        builder: async (ctx) => {
          const result = await worker.execute(String(ctx.input));
          return { built: result.text };
        },
      },
      // The default gate needs a fixer; supply a bare evaluate that is
      // satisfied immediately so the single dispatch terminates cleanly.
      gate: () => ({ satisfied: true }),
    });

    const { report } = await team.execute("build it");

    // team() reuses the supervisor engine but stamps its own discriminator
    // so team runs are distinguishable on the wire.
    expect(report.type).toBe("team");

    const callbackNode = find(report, (n) => n.type === "callback" && n.name === "builder");
    expect(callbackNode).toBeDefined();

    const agentNode = callbackNode!.children.find((c) => c.type === "agent");
    expect(agentNode).toBeDefined();
    expect(agentNode!.name).toBe("team-worker");

    const toolNode = agentNode!.children.find((c) => c.type === "tool");
    expect(toolNode).toBeDefined();

    expect(agentNode!.usage.total).toBeGreaterThan(0);
    expect(callbackNode!.usage).toEqual(sumUsage(callbackNode!.children));
  });

  it("orchestrator: a turn whose intent callback calls agent.execute() directly nests agent → tool inside the turn's report tree", async () => {
    const worker = buildAgentWithTool("orc-worker");

    const orc = ai.orchestrator<{ done: boolean }, { done: boolean }>({
      name: "nesting-orc",
      checkpointStore: ai.checkpoint.memory(),
      state: { done: false },
      intents: {
        delegate: {
          run: async (ctx) => {
            const result = await worker.execute(String(ctx.input));
            return { done: true, reply: result.text };
          },
        },
      },
      route: (ctx) => (ctx.iteration === 0 ? "delegate" : END),
    });

    const result = await orc.execute("kickoff", { sessionId: "s1", history: [] });

    // The orchestrator's report nests the dispatched supervisor turn,
    // which nests the callback → agent → tool chain.
    const report = result.report as unknown as BaseReport;

    const callbackNode = find(report, (n) => n.type === "callback" && n.name === "delegate");
    expect(callbackNode).toBeDefined();

    const agentNode = callbackNode!.children.find((c) => c.type === "agent");
    expect(agentNode).toBeDefined();
    expect(agentNode!.name).toBe("orc-worker");

    const toolNode = agentNode!.children.find((c) => c.type === "tool");
    expect(toolNode).toBeDefined();

    // sessionId propagates through the ambient frame onto the captured
    // agent subtree.
    expect(agentNode!.sessionId).toBe("s1");

    expect(agentNode!.usage.total).toBeGreaterThan(0);
    expect(callbackNode!.usage).toEqual(sumUsage(callbackNode!.children));
  });

  it("standalone agent.execute() outside any callback keeps its own self-root (no ambient frame leakage)", async () => {
    const solo = buildAgentWithTool("solo");

    const { report } = await solo.execute("hi");

    // No enclosing callback → the report is its own root, no parent.
    expect(report.rootRunId).toBe(report.runId);
    expect(report.parentRunId).toBeUndefined();
  });
});
