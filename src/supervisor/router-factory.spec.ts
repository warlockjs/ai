import { describe, expect, it } from "vitest";
import { END } from "../contracts/end.type";
import { MockSDK } from "../mock/mock-sdk";
import { buildScriptedAgent, routerDecision } from "./_test-helpers";
import { router, type RouterOutput } from "./router-factory";
import { supervisor } from "./supervisor";

/**
 * Unit coverage for `ai.router()` — the framework-generated routing
 * agent. Asserts the auto-built system prompt, the injected
 * `{ next, reasoning }` output schema, the validation rules, the JSON
 * Schema `enum` projection, and end-to-end dispatch when fed to a real
 * supervisor.
 */
function makeRouterModel(structuredOutput = false) {
  const sdk = MockSDK({
    responses: [{ content: routerDecision("triage", "start with triage"), finishReason: "stop" }],
    capabilities: structuredOutput ? { structuredOutput: true } : undefined,
  });

  return { sdk, model: sdk.model({ name: "router-model" }) };
}

const intents = {
  triage: buildScriptedAgent({ name: "triage", description: "Classify the request", responses: [] }),
  resolver: buildScriptedAgent({
    name: "resolver",
    description: "Produce the final answer",
    responses: [],
  }),
};

describe("ai.router — construction guards", () => {
  it("throws when `model` is missing", () => {
    expect(() => router({ model: undefined as never, intents })).toThrow(/`model` is required/);
  });

  it("throws when `intents` is missing", () => {
    const { model } = makeRouterModel();

    expect(() => router({ model, intents: undefined as never })).toThrow(/`intents` is required/);
  });

  it("throws when `intents` is empty", () => {
    const { model } = makeRouterModel();

    expect(() => router({ model, intents: {} })).toThrow(/at least one entry/);
  });

  it("produces a non-anonymous agent with a default name", () => {
    const { model } = makeRouterModel();

    const routerAgent = router({ model, intents });

    expect(routerAgent.name).toBe("router");
    expect(routerAgent.isAnonymous).toBe(false);
  });

  it("honors a custom `name`", () => {
    const { model } = makeRouterModel();

    const routerAgent = router({ name: "support-router", model, intents });

    expect(routerAgent.name).toBe("support-router");
  });
});

describe("ai.router — generated system prompt", () => {
  it("lists every intent with its description and the END sentinel", async () => {
    const { sdk, model } = makeRouterModel();
    const routerAgent = router({ model, intents });

    await routerAgent.execute("help me");

    const systemMessage = sdk.models[0].callHistory[0].messages.find(
      (message) => message.role === "system",
    );

    expect(systemMessage?.content).toContain("- triage: Classify the request");
    expect(systemMessage?.content).toContain("- resolver: Produce the final answer");
    expect(systemMessage?.content).toContain(END);
  });

  it("prepends the caller-supplied systemPrompt framing above the routing block", async () => {
    const { sdk, model } = makeRouterModel();
    const routerAgent = router({
      model,
      intents,
      systemPrompt: "You coordinate a support team.",
    });

    await routerAgent.execute("help me");

    const content = sdk.models[0]
      .callHistory[0]
      .messages.find((message) => message.role === "system")!.content as string;

    expect(content.indexOf("You coordinate a support team.")).toBeLessThan(
      content.indexOf("Available intents:"),
    );
  });

  it("lists a bare-callback intent by name only (no description source)", async () => {
    const { sdk, model } = makeRouterModel();
    const routerAgent = router({
      model,
      intents: { ...intents, log: (ctx) => ({ logged: ctx.input }) },
    });

    await routerAgent.execute("help me");

    const content = sdk.models[0]
      .callHistory[0]
      .messages.find((message) => message.role === "system")!.content as string;

    expect(content).toMatch(/- log(\n|$)/);
  });
});

describe("ai.router — generated output schema", () => {
  it("forwards a JSON Schema with the intent names + END as an enum", async () => {
    const { sdk, model } = makeRouterModel(true);
    const routerAgent = router({ model, intents });

    await routerAgent.execute("help me");

    const responseSchema = sdk.models[0].callHistory[0].options?.responseSchema as {
      properties: { next: { enum: string[] } };
    };

    expect(responseSchema.properties.next.enum).toEqual(["triage", "resolver", END]);
  });

  it("emits the parsed `next` value and defaults reasoning to empty string", async () => {
    const sdk = MockSDK({
      // No `reasoning` field — the schema validator must default it to "".
      responses: [{ content: JSON.stringify({ next: "triage" }), finishReason: "stop" }],
    });
    const model = sdk.model({ name: "router-model" });
    const routerAgent = router({ model, intents });

    const result: { data?: RouterOutput } = await routerAgent.execute("help me");

    expect(result.data?.next).toBe("triage");
    expect(result.data?.reasoning).toBe("");
  });

  it("emits the parsed `next` + `reasoning` through a real execute()", async () => {
    const { model } = makeRouterModel();
    const routerAgent = router({ model, intents });

    const result: { data?: RouterOutput } = await routerAgent.execute("help me");

    expect(result.data?.next).toBe("triage");
    expect(result.data?.reasoning).toBe("start with triage");
  });
});

describe("ai.router — composes into a supervisor", () => {
  it("drives dispatch end-to-end as the supervisor router", async () => {
    const routerSdk = MockSDK({
      responses: [
        { content: routerDecision("worker", "do the work"), finishReason: "stop" },
        { content: routerDecision(END, "done"), finishReason: "stop" },
      ],
    });
    const routerModel = routerSdk.model({ name: "router-model" });

    const worker = buildScriptedAgent({
      name: "worker",
      description: "Does the work",
      responses: [{ content: "worked", finishReason: "stop" }],
    });

    const routerAgent = router({ model: routerModel, intents: { worker } });

    const supervisorInstance = supervisor({
      name: "router-helper-supervisor",
      router: routerAgent,
      intents: { worker },
      maxIterations: 3,
    });

    const result = await supervisorInstance.execute("go");

    expect(result.error).toBeUndefined();
    expect(result.report.iterations).toBeGreaterThanOrEqual(1);
    expect(result.report.snapshots[0].result.worker).toBeDefined();
  });
});
