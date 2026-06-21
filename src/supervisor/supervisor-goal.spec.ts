import { describe, expect, it } from "vitest";
import { agent } from "../agent/agent";
import type { AgentContract } from "../contracts/agent/agent.contract";
import { END } from "../contracts/end.type";
import type { MockModelResponse } from "../mock/mock-config.type";
import { MockModel } from "../mock/mock-model";
import { MockSDK } from "../mock/mock-sdk";
import { systemPrompt } from "../system-prompt/system-prompt";
import { routerDecision } from "./_test-helpers";
import { supervisor } from "./supervisor";

/**
 * Tests for `SupervisorConfig.goal` — the natural-language objective
 * that's resolved at construction, surfaced on every callback context,
 * and injected into the router-agent's per-turn user message.
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

describe("supervisor — goal field", () => {
  it("surfaces resolved goal on RouteContext.goal", async () => {
    let seen: string | undefined;
    const { unit } = buildAgentWithModel({
      name: "noop",
      description: "noop",
      responses: [{ content: "ok", finishReason: "stop" }],
    });

    const sup = supervisor({
      name: "goal-route-ctx",
      goal: "Recommend the best AC unit for the user's home.",
      intents: { noop: unit },
      route: ctx => {
        seen = ctx.goal;
        return ctx.iteration === 0 ? "noop" : END;
      },
    });

    await sup.execute("hi");
    expect(seen).toBe("Recommend the best AC unit for the user's home.");
  });

  it("surfaces goal on EvaluateContext.goal for satisfaction checks", async () => {
    let seen: string | undefined;
    const { unit } = buildAgentWithModel({
      name: "noop",
      description: "noop",
      responses: [{ content: "ok", finishReason: "stop" }],
    });

    const sup = supervisor({
      name: "goal-evaluate-ctx",
      goal: "Produce a complete BTU calculation.",
      intents: { noop: unit },
      route: ctx => (ctx.iteration === 0 ? "noop" : END),
      evaluate: ctx => {
        seen = ctx.goal;
        return { satisfied: true };
      },
    });

    await sup.execute("hi");
    expect(seen).toBe("Produce a complete BTU calculation.");
  });

  it("defaults goal to undefined when not configured", async () => {
    let seen: string | undefined = "untouched";
    const { unit } = buildAgentWithModel({
      name: "noop",
      description: "noop",
      responses: [{ content: "ok", finishReason: "stop" }],
    });

    const sup = supervisor({
      name: "no-goal",
      intents: { noop: unit },
      route: ctx => {
        seen = ctx.goal;
        return ctx.iteration === 0 ? "noop" : END;
      },
    });

    await sup.execute("hi");
    expect(seen).toBeUndefined();
  });

  it("resolves SystemPromptContract goal to plain text", async () => {
    let seen: string | undefined;
    const { unit } = buildAgentWithModel({
      name: "noop",
      description: "noop",
      responses: [{ content: "ok", finishReason: "stop" }],
    });

    const goalPrompt = systemPrompt().instruction(
      "Help the customer pick a product within budget.",
    );

    const sup = supervisor({
      name: "goal-system-prompt",
      goal: goalPrompt,
      intents: { noop: unit },
      route: ctx => {
        seen = ctx.goal;
        return ctx.iteration === 0 ? "noop" : END;
      },
    });

    await sup.execute("hi");
    expect(seen).toContain("Help the customer pick a product within budget.");
  });

  it("injects goal into the router agent's per-turn user message", async () => {
    const { unit: routerAgent, model: routerModel } = buildAgentWithModel({
      name: "router",
      description: "router",
      responses: [{ content: routerDecision("responder"), finishReason: "stop" }],
    });
    const { unit: responder } = buildAgentWithModel({
      name: "responder",
      description: "responder",
      responses: [{ content: "done", finishReason: "stop" }],
    });

    const sup = supervisor({
      name: "goal-router-injection",
      goal: "Resolve the customer's complaint efficiently.",
      router: routerAgent,
      intents: { responder },
      maxIterations: 2,
      evaluate: () => ({ satisfied: true }),
    });

    await sup.execute("complaint");

    // Router's user message is the last `user` role message in the
    // first call's messages array.
    const routerCall = routerModel.callHistory[0].messages;
    const userMsg = [...routerCall].reverse().find(m => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg?.content).toContain("Goal:");
    expect(userMsg?.content).toContain(
      "Resolve the customer's complaint efficiently.",
    );
  });

  it("router prompt has no Goal section when goal is unset", async () => {
    const { unit: routerAgent, model: routerModel } = buildAgentWithModel({
      name: "router",
      description: "router",
      responses: [{ content: routerDecision("responder"), finishReason: "stop" }],
    });
    const { unit: responder } = buildAgentWithModel({
      name: "responder",
      description: "responder",
      responses: [{ content: "done", finishReason: "stop" }],
    });

    const sup = supervisor({
      name: "no-goal-router-injection",
      router: routerAgent,
      intents: { responder },
      maxIterations: 2,
      evaluate: () => ({ satisfied: true }),
    });

    await sup.execute("hi");

    const routerCall = routerModel.callHistory[0].messages;
    const userMsg = [...routerCall].reverse().find(m => m.role === "user");
    expect(userMsg?.content).not.toContain("Goal:");
  });
});
