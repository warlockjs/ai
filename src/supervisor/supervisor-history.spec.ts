import { describe, expect, it } from "vitest";
import { agent } from "../agent/agent";
import type { AgentContract } from "../contracts/agent/agent.contract";
import type { Message } from "../contracts/conversation-message.type";
import { END } from "../contracts/end.type";
import type { MockModelResponse } from "../mock/mock-config.type";
import { MockModel } from "../mock/mock-model";
import { MockSDK } from "../mock/mock-sdk";
import { routerDecision } from "./_test-helpers";
import { supervisor } from "./supervisor";

/**
 * Build an agent + return its underlying `MockModel` so the test can
 * inspect the exact `messages` array forwarded by the agent layer.
 * Mirrors `buildScriptedAgent` but exposes the model.
 */
function buildAgentWithModel(params: {
  name: string;
  description?: string;
  responses: MockModelResponse[];
}): { unit: AgentContract; model: MockModel } {
  const sdk = MockSDK({ responses: params.responses });
  const model = sdk.model({ name: `${params.name}-model` }) as MockModel;
  const unit = agent({
    name: params.name,
    description: params.description,
    model,
  });
  return { unit, model };
}

const HISTORY: Message[] = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "hello!" },
  { role: "user", content: "what's the weather?" },
  { role: "assistant", content: "sunny" },
  { role: "user", content: "thanks" },
];

/**
 * Pull the user/assistant slice out of the messages the agent sent to
 * its model. The agent prepends a system prompt + appends the current
 * input; we only care about the history-derived turns in between.
 */
function extractHistorySlice(messages: Message[]): Message[] {
  return messages.filter((m) => m.role === "user" || m.role === "assistant").slice(0, -1);
}

describe("supervisor — history threading (Phase 0)", () => {
  it("forwards history option to dispatched agents", async () => {
    const { unit, model } = buildAgentWithModel({
      name: "responder",
      description: "responder",
      responses: [{ content: "ok", finishReason: "stop" }],
    });

    const sup = supervisor({
      name: "history-forward",
      intents: { responder: unit },
      route: (ctx) => (ctx.iteration === 0 ? "responder" : END),
    });

    const result = await sup.execute("current", { history: HISTORY });
    expect(result.error).toBeUndefined();

    expect(model.callCount).toBe(1);
    expect(extractHistorySlice(model.callHistory[0].messages)).toEqual(HISTORY);
  });

  it("exposes history on RouteContext (read-only)", async () => {
    let seen: ReadonlyArray<Message> | undefined;
    const { unit } = buildAgentWithModel({
      name: "noop",
      description: "noop",
      responses: [{ content: "ok", finishReason: "stop" }],
    });

    const sup = supervisor({
      name: "history-route-ctx",
      intents: { noop: unit },
      route: (ctx) => {
        seen = ctx.history;
        return ctx.iteration === 0 ? "noop" : END;
      },
    });

    await sup.execute("hi", { history: HISTORY });
    expect(seen).toEqual(HISTORY);
  });

  it("defaults history to an empty array when omitted", async () => {
    let seen: ReadonlyArray<Message> | undefined;
    const { unit } = buildAgentWithModel({
      name: "noop",
      description: "noop",
      responses: [{ content: "ok", finishReason: "stop" }],
    });

    const sup = supervisor({
      name: "history-default-empty",
      intents: { noop: unit },
      route: (ctx) => {
        seen = ctx.history;
        return ctx.iteration === 0 ? "noop" : END;
      },
    });

    await sup.execute("hi");
    expect(seen).toEqual([]);
  });

  it("applies historyWindow.agents (last-N slice)", async () => {
    const { unit, model } = buildAgentWithModel({
      name: "responder",
      description: "responder",
      responses: [{ content: "ok", finishReason: "stop" }],
    });

    const sup = supervisor({
      name: "history-window-agents",
      intents: { responder: unit },
      route: (ctx) => (ctx.iteration === 0 ? "responder" : END),
      historyWindow: { agents: 2 },
    });

    await sup.execute("current", { history: HISTORY });
    expect(extractHistorySlice(model.callHistory[0].messages)).toEqual(HISTORY.slice(-2));
  });

  it("entry-level history slicer overrides historyWindow.agents", async () => {
    const { unit, model } = buildAgentWithModel({
      name: "responder",
      description: "responder",
      responses: [{ content: "ok", finishReason: "stop" }],
    });

    const sup = supervisor({
      name: "history-entry-slicer",
      intents: {
        responder: {
          agent: unit,
          history: (ctx) => ctx.history.filter((m) => m.role === "user"),
        },
      },
      route: (ctx) => (ctx.iteration === 0 ? "responder" : END),
      historyWindow: { agents: 1 },
    });

    await sup.execute("current", { history: HISTORY });
    expect(extractHistorySlice(model.callHistory[0].messages)).toEqual(
      HISTORY.filter((m) => m.role === "user"),
    );
  });

  it("entry slicer returning [] sends no history", async () => {
    const { unit, model } = buildAgentWithModel({
      name: "rag",
      description: "rag",
      responses: [{ content: "ok", finishReason: "stop" }],
    });

    const sup = supervisor({
      name: "history-empty-slice",
      intents: {
        rag: { agent: unit, history: () => [] },
      },
      route: (ctx) => (ctx.iteration === 0 ? "rag" : END),
    });

    await sup.execute("current", { history: HISTORY });
    expect(extractHistorySlice(model.callHistory[0].messages)).toEqual([]);
  });

  it("forwards sliced history to the router agent via historyWindow.router", async () => {
    const { unit: routerAgent, model: routerModel } = buildAgentWithModel({
      name: "router",
      description: "router",
      responses: [{ content: routerDecision("responder"), finishReason: "stop" }],
    });
    const { unit: responderAgent } = buildAgentWithModel({
      name: "responder",
      description: "responder",
      responses: [{ content: "done", finishReason: "stop" }],
    });

    const sup = supervisor({
      name: "history-window-router",
      intents: { responder: responderAgent },
      router: routerAgent,
      historyWindow: { router: 2 },
      maxIterations: 2,
      evaluate: () => ({ satisfied: true }),
    });

    await sup.execute("hello", { history: HISTORY });
    expect(extractHistorySlice(routerModel.callHistory[0].messages)).toEqual(HISTORY.slice(-2));
  });

  it("ack defaults to no history (historyWindow.ack defaults to 0)", async () => {
    const { unit: ackAgent, model: ackModel } = buildAgentWithModel({
      name: "ack",
      description: "ack",
      responses: [{ content: "got it", finishReason: "stop" }],
    });
    const { unit: responder } = buildAgentWithModel({
      name: "responder",
      description: "responder",
      responses: [{ content: "ok", finishReason: "stop" }],
    });

    const sup = supervisor({
      name: "history-ack-default",
      intents: { responder },
      route: (ctx) => (ctx.iteration === 0 ? "responder" : END),
      ack: { agent: ackAgent },
    });

    await sup.execute("hello", { history: HISTORY });

    expect(ackModel.callCount).toBeGreaterThan(0);
    expect(extractHistorySlice(ackModel.callHistory[0].messages)).toEqual([]);
  });

  describe("config.history (factory-level default)", () => {
    it("uses config.history when no per-call history supplied", async () => {
      const { unit, model } = buildAgentWithModel({
        name: "responder",
        description: "responder",
        responses: [{ content: "ok", finishReason: "stop" }],
      });

      const sup = supervisor({
        name: "history-config-default",
        intents: { responder: unit },
        route: (ctx) => (ctx.iteration === 0 ? "responder" : END),
        history: HISTORY,
      });

      await sup.execute("current");
      expect(extractHistorySlice(model.callHistory[0].messages)).toEqual(HISTORY);
    });

    it("per-call options.history overrides config.history when both set", async () => {
      const { unit, model } = buildAgentWithModel({
        name: "responder",
        description: "responder",
        responses: [{ content: "ok", finishReason: "stop" }],
      });

      const callHistory: Message[] = [{ role: "user", content: "fresh turn" }];

      const sup = supervisor({
        name: "history-config-overridden",
        intents: { responder: unit },
        route: (ctx) => (ctx.iteration === 0 ? "responder" : END),
        history: HISTORY,
      });

      await sup.execute("current", { history: callHistory });
      expect(extractHistorySlice(model.callHistory[0].messages)).toEqual(callHistory);
    });
  });
});
