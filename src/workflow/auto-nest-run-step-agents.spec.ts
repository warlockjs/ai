import { describe, expect, it } from "vitest";
import { agent } from "../agent/agent";
import type { BaseReport } from "../contracts/result/base-report.type";
import type { Usage } from "../contracts/result/usage.type";
import { MockSDK } from "../mock/mock-sdk";
import {
  clearObservers,
  registerObserver,
  setObserveAll,
} from "../observe/observer-registry";
import type { Observer } from "../observe/observer.contract";
import { passthrough } from "../supervisor/_test-helpers";
import { tool } from "../tool/tool";
import { step } from "./step";
import { workflow } from "./workflow";

/**
 * Auto-nesting of agents invoked DIRECTLY inside a `run` step's callback —
 * the workflow-side counterpart to
 * `supervisor/auto-nest-callback-agents.spec.ts`.
 *
 * Before this fix, a `run` step that called `agent.execute()` directly
 * (rather than the declarative `agent:` field) produced TWO disconnected
 * top-level traces — one type "agent", one type "workflow" — with neither
 * carrying the other as a child. An ambient `RunFrame` installed around
 * `step.run`'s body (mirroring supervisor/team/orchestrator callbacks) now
 * lets the agent self-attach to the step's captured `children`, which the
 * engine flattens into `report.children` alongside any `step.agent`
 * reports — no manual id threading, no observe-routing double-count.
 */

const USAGE: Usage = { input: 10, output: 5, total: 15 };

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

function makeFakeObserver(): Observer & { collected: BaseReport[] } {
  const collected: BaseReport[] = [];

  return {
    collected,
    collect(report) {
      collected.push(report as BaseReport);
    },
  };
}

/** A fresh agent that calls one tool then answers, with non-zero usage. */
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

describe("auto-nest agents invoked inside a workflow run step", () => {
  it("a run step that calls agent.execute() directly nests agent → tool under report.children with usage rolled up", async () => {
    const worker = buildAgentWithTool("worker");

    const wf = workflow({
      name: "nesting-wf",
      steps: [
        step({
          name: "delegate",
          run: async () => {
            const result = await worker.execute("go");
            return { reply: result.text };
          },
        }),
      ],
    });

    const { report } = await wf.execute({ input: {} });

    expect(report.type).toBe("workflow");
    expect(report.children).toHaveLength(1);

    const agentNode = report.children[0];
    expect(agentNode.type).toBe("agent");
    expect(agentNode.name).toBe("worker");

    // tool nested under the agent — the run-frame doesn't just capture the
    // top-level call, the agent's OWN subtree survives intact.
    const toolNode = agentNode.children.find((c) => c.type === "tool");
    expect(toolNode).toBeDefined();
    expect(toolNode!.name).toBe("echo");

    // Lineage: relinked to the workflow root by the terminal stamp pass —
    // a direct child (no intermediate "step" node in the tree today).
    expect(agentNode.rootRunId).toBe(report.runId);
    expect(agentNode.parentRunId).toBe(report.runId);

    // Cost rolled up into the workflow's own usage instead of staying $0.
    expect(agentNode.usage.total).toBeGreaterThan(0);
    expect(report.usage.total).toBeGreaterThanOrEqual(agentNode.usage.total);
  });

  it("routes only ONE trace to observers (the workflow's) — the nested agent does not also self-route", async () => {
    const observer = makeFakeObserver();
    registerObserver(observer);
    setObserveAll(true);

    try {
      const worker = buildAgentWithTool("obs-worker");

      const wf = workflow({
        name: "obs-nesting-wf",
        steps: [
          step({
            name: "delegate",
            run: async () => {
              await worker.execute("go");
            },
          }),
        ],
      });

      await wf.execute({ input: {} });

      // Exactly one top-level trace — the workflow's. The nested agent run
      // must NOT also appear as a second, disconnected entry.
      expect(observer.collected).toHaveLength(1);
      expect(observer.collected[0].type).toBe("workflow");
    } finally {
      clearObservers();
    }
  });

  it("a step mixing two direct agent calls in one run captures both", async () => {
    const first = buildAgentWithTool("first");
    const second = buildAgentWithTool("second");

    const wf = workflow({
      name: "two-calls-wf",
      steps: [
        step({
          name: "delegate",
          run: async () => {
            const a = await first.execute("go");
            const b = await second.execute("go");
            return { combined: `${a.text}+${b.text}` };
          },
        }),
      ],
    });

    const { report } = await wf.execute({ input: {} });

    expect(report.children).toHaveLength(2);
    expect(report.children.map(c => c.name)).toEqual(["first", "second"]);
    expect(report.usage).toEqual(sumUsage(report.children));
  });

  it("a failed retry's captured children never bleed into the successful attempt's snapshot", async () => {
    const worker = buildAgentWithTool("retry-worker");
    let attempt = 0;

    const wf = workflow({
      name: "retry-wf",
      steps: [
        step({
          name: "flaky",
          retry: { attempts: 2 },
          run: async () => {
            attempt += 1;

            if (attempt === 1) {
              // Calls the agent (captured), THEN throws — the failed
              // attempt's capture must not survive into attempt 2.
              await worker.execute("first try");
              throw new Error("transient");
            }

            // Second attempt calls nothing observable.
            return { ok: true };
          },
        }),
      ],
    });

    const { report } = await wf.execute({ input: {} });

    expect(report.status).toBe("completed");
    expect(attempt).toBe(2);
    // The successful retry captured nothing — the failed attempt's agent
    // call must not have leaked through.
    expect(report.children).toHaveLength(0);
    expect(report.steps.flaky.children).toBeUndefined();
  });

  it("a run step that calls nothing observable produces no children (unaffected by the fix)", async () => {
    const wf = workflow({
      name: "no-op-wf",
      steps: [step({ name: "plain", run: () => ({ ok: true }) })],
    });

    const { report } = await wf.execute({ input: {} });

    expect(report.children).toHaveLength(0);
  });

  it("mixes a declarative step.agent report with a run step's captured agent — both land in report.children", async () => {
    const declarative = buildAgentWithTool("declarative");
    const adhoc = buildAgentWithTool("adhoc");

    const wf = workflow({
      name: "mixed-wf",
      steps: [
        step({ name: "s1", agent: declarative, input: () => ({ prompt: "x" }) }),
        step({
          name: "s2",
          run: async () => {
            await adhoc.execute("y");
          },
        }),
      ],
    });

    const { report } = await wf.execute({ input: {} });

    expect(report.children).toHaveLength(2);
    expect(report.children.map(c => c.name)).toEqual(["declarative", "adhoc"]);
  });

  it("propagates sessionId through the ambient frame onto the captured agent subtree", async () => {
    const worker = buildAgentWithTool("session-worker");

    const wf = workflow({
      name: "session-wf",
      steps: [
        step({
          name: "delegate",
          run: async () => {
            await worker.execute("go");
          },
        }),
      ],
    });

    const { report } = await wf.execute({ input: {}, sessionId: "s1" });

    expect(report.children[0].sessionId).toBe("s1");
  });

  it("standalone agent.execute() outside any workflow step keeps its own self-root (no ambient frame leakage)", async () => {
    const solo = buildAgentWithTool("solo");

    const { report } = await solo.execute("hi");

    expect(report.rootRunId).toBe(report.runId);
    expect(report.parentRunId).toBeUndefined();
  });
});
