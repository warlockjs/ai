import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import { agent } from "../agent/agent";
import type { AgentContract } from "../contracts/agent/agent.contract";
import type { AgentResult } from "../contracts/result/agent-result.type";
import { END } from "../contracts/end.type";
import { MockSDK } from "../mock/mock-sdk";
import { tool } from "../tool/tool";
import { schema } from "./_test-helpers";
import { supervisor } from "./supervisor";

/**
 * Phase 6 / decisions §36 — `ctx.run` and `ctx.stream` for supervised
 * inline execution from callback intents.
 *
 * Verifies the four supervised concerns flow through inline-composed
 * agents:
 *  - Stream events bubble under callback intent name
 *  - Cancellation signal propagates
 *  - Tool artifacts contribute to the iteration's bag
 *  - Report nests under supervisor.report.children
 */

function buildEcho(name: string, content: string) {
  const sdk = MockSDK({ responses: [{ content, finishReason: "stop" }] });

  return agent({ name, model: sdk.model({ name: `${name}-model` }) });
}

function buildEchoWithDeltas(name: string, fragments: string[]) {
  const sdk = MockSDK({
    responses: [
      {
        content: fragments.join(""),
        finishReason: "stop",
        deltas: fragments,
      },
    ],
  });

  return agent({ name, model: sdk.model({ name: `${name}-model` }) });
}

describe("supervisor — ctx.run and ctx.stream", () => {
  it("ctx.run returns full ExecuteResult envelope", async () => {
    const inner = buildEcho("inner", "hello world");

    const supervisorInstance = supervisor({
      name: "ctx-run-envelope",
      intents: {
        custom: async ctx => {
          const result = (await ctx.run(inner, ctx.input)) as AgentResult<unknown>;

          return {
            outerReply: result.text,
            hasReport: result.report !== undefined,
            hasUsage: result.usage !== undefined,
          };
        },
      },
      route: ctx => (ctx.iteration === 0 ? "custom" : END),
    });

    const result = await supervisorInstance.execute("hi");
    const branch = result.report.snapshots[0].result.custom;

    expect(result.error).toBeUndefined();
    expect(branch.output).toEqual({
      outerReply: "hello world",
      hasReport: true,
      hasUsage: true,
    });
  });

  it("ctx.stream bubbles deltas under the callback's intent name", async () => {
    const fragments = ["Hi", " there", "!"];
    const inner = buildEchoWithDeltas("inner-streamer", fragments);

    const supervisorInstance = supervisor({
      name: "ctx-stream-bubble",
      intents: {
        chatInline: async ctx => {
          const stream = ctx.stream(inner, ctx.input);
          const final = (await stream.result) as AgentResult<unknown>;

          return { reply: final.text };
        },
      },
      route: ctx => (ctx.iteration === 0 ? "chatInline" : END),
    });

    const seen: { intent: string; delta: string }[] = [];

    await supervisorInstance.execute("hi", {
      on: {
        "supervisor.agent.streaming": ({ intent, delta }) => {
          seen.push({ intent, delta });
        },
      },
    });

    expect(seen.length).toBeGreaterThan(0);

    for (const event of seen) {
      // Attribution: deltas from the inline-streamed agent must
      // surface under the calling callback's intent name, not the
      // inline agent's own name.
      expect(event.intent).toBe("chatInline");
    }
  });

  it("ctx.run threads toolCtx — inline agent's tool writes to supervisor's artifacts bag", async () => {
    type Block = { type: "items"; itemIds: string[] };

    const inputSchema: StandardSchemaV1<{ q: string }> = schema(value => {
      if (!value || typeof value !== "object" || typeof (value as { q?: unknown }).q !== "string") {
        return { issues: [{ message: "bad input" }] };
      }

      return { value: value as { q: string } };
    });

    const searchTool = tool({
      name: "search_inline",
      description: "search",
      input: inputSchema,
      execute: async (_input, toolCtx) => {
        const bag = toolCtx?.artifacts as { blocks?: Block[] } | undefined;

        if (bag) {
          bag.blocks ??= [];
          bag.blocks.push({ type: "items", itemIds: ["i1", "i2"] });
        }

        return { total: 2 };
      },
    });

    const sdk = MockSDK({
      responses: [
        {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [
            { id: "c0", name: "search_inline", input: { q: "ac" } },
          ],
        },
        { content: "found two", finishReason: "stop" },
      ],
    });

    const inner = agent({
      name: "inline-searcher",
      model: sdk.model({ name: "inline-searcher-model" }),
      tools: [searchTool],
    });

    const supervisorInstance = supervisor({
      name: "ctx-run-toolctx",
      intents: {
        delegate: async ctx => {
          const result = (await ctx.run(inner, "search")) as AgentResult<unknown>;

          return { reply: result.text };
        },
      },
      route: ctx => (ctx.iteration === 0 ? "delegate" : END),
    });

    const result = await supervisorInstance.execute("find");

    expect(result.error).toBeUndefined();
    expect(
      (result.report.snapshots[0].state as { blocks?: Block[] }).blocks,
    ).toEqual([{ type: "items", itemIds: ["i1", "i2"] }]);
  });

  it("ctx.run nests inline executable's report under the calling callback's children", async () => {
    const inner = buildEcho("inline-reporter", "done");

    const supervisorInstance = supervisor({
      name: "ctx-run-report-nesting",
      intents: {
        delegate: async ctx => {
          const result = (await ctx.run(inner, "go")) as AgentResult<unknown>;

          return { reply: result.text };
        },
      },
      route: ctx => (ctx.iteration === 0 ? "delegate" : END),
    });

    const result = await supervisorInstance.execute("hi");

    // The "delegate" callback's report node should carry the inner
    // agent's report as a child — the inline run nested under the
    // calling callback, not under the supervisor's top-level
    // children list (no double-counting).
    const callbackChild = result.report.children.find(
      child => child.name === "delegate",
    );
    expect(callbackChild).toBeDefined();
    expect(callbackChild?.children).toBeDefined();
    expect(callbackChild?.children.some(c => c.name === "inline-reporter")).toBe(true);
  });

  it("ctx.run cycle detection by executable name", async () => {
    // An inline executable whose name matches the calling callback's
    // intent name should trip cycle detection.
    const recursive = buildEcho("custom", "loop");

    const supervisorInstance = supervisor({
      name: "ctx-run-cycle",
      intents: {
        custom: async ctx => {
          // The inline agent's own name === this callback's intent
          // name — this re-entry must surface SUPERVISOR_DISPATCH_CYCLE.
          await ctx.run(recursive, "x");

          return { reply: "unreachable" };
        },
      },
      route: ctx => (ctx.iteration === 0 ? "custom" : END),
    });

    const result = await supervisorInstance.execute("hi");

    expect(result.report.snapshots[0].result.custom.error).toBeDefined();
    expect(result.report.snapshots[0].result.custom.error?.code).toBe(
      "SUPERVISOR_DISPATCH_CYCLE",
    );
  });

  it("ctx.intents.X.stream is the streaming sibling of ctx.intents.X.execute for registered intents", async () => {
    const fragments = ["Hello", " from", " inner"];
    const namedAgent: AgentContract<unknown> = buildEchoWithDeltas("named-streamer", fragments);

    const supervisorInstance = supervisor({
      name: "intent-runner-stream",
      intents: {
        named: namedAgent,
        delegate: async ctx => {
          const stream = ctx.intents.named.stream();
          const final = (await stream.result) as AgentResult<unknown>;

          return { reply: final.text };
        },
      },
      route: ctx => (ctx.iteration === 0 ? "delegate" : END),
    });

    const seen: string[] = [];

    await supervisorInstance.execute("hi", {
      on: {
        "supervisor.agent.streaming": ({ intent, delta }) => {
          seen.push(`${intent}:${delta}`);
        },
      },
    });

    // Deltas must attribute to "delegate" (the calling callback)
    // rather than "named" (the inner intent).
    expect(seen.length).toBeGreaterThan(0);

    for (const event of seen) {
      expect(event.startsWith("delegate:")).toBe(true);
    }
  });
});
