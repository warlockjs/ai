import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import { agent } from "../agent/agent";
import { END } from "../contracts/end.type";
import { SupervisorFailedError } from "../errors";
import { MockSDK } from "../mock/mock-sdk";
import { buildScriptedAgent, schema } from "./_test-helpers";
import { supervisor } from "./supervisor";

/**
 * Phase 7 / decisions §37 — classifier dispatch mode.
 *
 * Classifier is the iter-0 prelude that classifies the input and
 * picks the intent that runs first. Composes with router/route
 * (which take iter 1+); when configured alone, supervisor
 * terminates after iter 0's branch settles.
 */

function buildClassifierAgent(name: string, output: { intent: string; reasoning?: string; confidence?: number }) {
  // Output a JSON body the supervisor parses as ClassifierOutput.
  const sdk = MockSDK({
    responses: [
      {
        content: JSON.stringify(output),
        finishReason: "stop",
      },
    ],
    capabilities: { structuredOutput: true },
  });

  const classifierOutputSchema: StandardSchemaV1<{ intent: string; reasoning?: string; confidence?: number }> = schema(value => {
    if (!value || typeof value !== "object" || typeof (value as { intent?: unknown }).intent !== "string") {
      return { issues: [{ message: "expected { intent: string }" }] };
    }

    return { value: value as { intent: string; reasoning?: string; confidence?: number } };
  });

  return agent({
    name,
    description: "classifier",
    model: sdk.model({ name: `${name}-model` }),
    output: classifierOutputSchema,
  });
}

describe("supervisor — classifier dispatch (Phase 7)", () => {
  it("classifier picks intent on iter 0; supervisor terminates after dispatched intent in classifier-alone mode", async () => {
    const billing = buildScriptedAgent({
      name: "billing",
      description: "handles billing",
      responses: [{ content: "billing reply", finishReason: "stop" }],
    });

    const classifyAgent = buildClassifierAgent("classify", { intent: "billing" });

    const supervisorInstance = supervisor({
      name: "classifier-alone",
      intents: { billing },
      classifier: { agent: classifyAgent },
    });

    const result = await supervisorInstance.execute("I want a refund");

    expect(result.error).toBeUndefined();
    expect(result.report.terminatedBy).toBe("classifier");
    expect(result.report.iterations).toBe(1);
    expect(result.report.classifier?.intent).toBe("billing");
    expect(result.report.snapshots[0].decision.source).toBe("classifier");
  });

  it("classifier picks iter 0; router takes over from iter 1+ when both configured", async () => {
    const billing = buildScriptedAgent({
      name: "billing",
      description: "billing handler",
      responses: [{ content: "billing reply", finishReason: "stop" }],
    });

    const shipping = buildScriptedAgent({
      name: "shipping",
      description: "shipping handler",
      responses: [{ content: "shipping reply", finishReason: "stop" }],
    });

    const classifyAgent = buildClassifierAgent("classify", { intent: "billing" });

    const supervisorInstance = supervisor({
      name: "classifier-with-route",
      intents: { billing, shipping },
      classifier: { agent: classifyAgent },
      route: ctx => (ctx.iteration === 0 ? "billing" : ctx.iteration === 1 ? "shipping" : END),
    });

    const result = await supervisorInstance.execute("input");

    expect(result.error).toBeUndefined();
    expect(result.report.iterations).toBe(3);
    // Iter 0 dispatched by classifier:
    expect(result.report.snapshots[0].decision.source).toBe("classifier");
    expect(result.report.snapshots[0].result.billing).toBeDefined();
    // Iter 1 dispatched by route:
    expect(result.report.snapshots[1].decision.source).toBe("route");
    expect(result.report.snapshots[1].result.shipping).toBeDefined();
  });

  it("callback classifier — deterministic, no LLM call", async () => {
    const smalltalk = buildScriptedAgent({
      name: "smalltalk",
      description: "small talk",
      responses: [{ content: "hi!", finishReason: "stop" }],
    });

    const supervisorInstance = supervisor({
      name: "classifier-callback",
      intents: { smalltalk },
      classifier: ctx => ({
        intent: typeof ctx.input === "string" && ctx.input.startsWith("hi") ? "smalltalk" : "smalltalk",
        reasoning: "starts with hi",
      }),
    });

    const result = await supervisorInstance.execute("hi there");

    expect(result.error).toBeUndefined();
    expect(result.report.classifier?.intent).toBe("smalltalk");
    expect(result.report.classifier?.reasoning).toBe("starts with hi");
    // Callback classifier produced zero usage — no LLM call.
    expect(result.report.classifier?.usage.total).toBe(0);
  });

  it("refine overrides intent on weak confidence", async () => {
    const fallback = buildScriptedAgent({
      name: "fallback",
      description: "catch-all fallback",
      responses: [{ content: "fallback reply", finishReason: "stop" }],
    });

    const billing = buildScriptedAgent({
      name: "billing",
      description: "billing handler",
      responses: [{ content: "billing reply", finishReason: "stop" }],
    });

    const classifyAgent = buildClassifierAgent("classify", {
      intent: "billing",
      confidence: 0.4,
    });

    const supervisorInstance = supervisor({
      name: "classifier-refine-override",
      intents: { billing, fallback },
      classifier: {
        agent: classifyAgent,
        refine: ctx => {
          const conf = ctx.result.data.confidence ?? 1;

          if (conf < 0.7) {
            return { intent: "fallback" };
          }

          return undefined;
        },
      },
    });

    const result = await supervisorInstance.execute("ambiguous input");

    expect(result.error).toBeUndefined();
    expect(result.report.classifier?.intent).toBe("fallback");
    expect(result.report.classifier?.refined).toBe(true);
    expect(result.report.snapshots[0].result.fallback).toBeDefined();
    expect(result.report.snapshots[0].result.billing).toBeUndefined();
  });

  it("refine returning END halts before any dispatch", async () => {
    const intent = buildScriptedAgent({
      name: "intent",
      description: "should not run",
      responses: [{ content: "unreachable", finishReason: "stop" }],
    });

    const classifyAgent = buildClassifierAgent("classify", { intent: "intent" });

    const supervisorInstance = supervisor({
      name: "classifier-refine-end",
      intents: { intent },
      classifier: {
        agent: classifyAgent,
        refine: () => END,
      },
    });

    const result = await supervisorInstance.execute("policy violation");

    expect(result.error).toBeUndefined();
    expect(result.report.terminatedBy).toBe("classifier");
    expect(result.report.iterations).toBe(1);
    // Halted iteration carries an "end" decision and zero dispatched branches:
    expect(Object.keys(result.report.snapshots[0].result)).toHaveLength(0);
    expect(result.report.classifier?.halted).toBe(true);
    expect(result.report.classifier?.intent).toBeUndefined();
  });

  it("factory throws on classifier + initialAgent coexistence", () => {
    const dummy = buildScriptedAgent({
      name: "dummy",
      description: "d",
      responses: [{ content: "x", finishReason: "stop" }],
    });

    const classifyAgent = buildClassifierAgent("classify", { intent: "dummy" });

    expect(() =>
      supervisor({
        name: "classifier-vs-initialAgent",
        intents: { dummy },
        classifier: { agent: classifyAgent },
        initialAgent: "dummy",
      } as any),
    ).toThrow(
      expect.objectContaining({
        name: "SupervisorFailedError",
      }) as unknown as SupervisorFailedError,
    );
  });

  it("classifier output strip-merges into supervisor state per output schema", async () => {
    const billing = buildScriptedAgent({
      name: "billing",
      description: "billing",
      responses: [{ content: "billing reply", finishReason: "stop" }],
    });

    const classifyAgent = buildClassifierAgent("classify", {
      intent: "billing",
      reasoning: "user mentioned refund",
      confidence: 0.92,
    });

    const supervisorInstance = supervisor({
      name: "classifier-state-merge",
      intents: { billing },
      classifier: { agent: classifyAgent },
    });

    const result = await supervisorInstance.execute("refund request");

    const state = result.report.snapshots[0].state as {
      intent?: string;
      reasoning?: string;
      confidence?: number;
    };

    expect(state.intent).toBe("billing");
    expect(state.reasoning).toBe("user mentioned refund");
    expect(state.confidence).toBe(0.92);
  });

  it("ctx.classifier is exposed on RouteContext / DispatchContext / EvaluateContext after iter 0", async () => {
    const captured: { route?: unknown; dispatch?: unknown; evaluate?: unknown } = {};

    const billing = buildScriptedAgent({
      name: "billing",
      description: "billing",
      responses: [{ content: "ok", finishReason: "stop" }],
    });

    const supervisorInstance = supervisor({
      name: "classifier-ctx-expose",
      intents: {
        billing,
        capture: async ctx => {
          captured.dispatch = ctx.classifier?.intent;

          return { capturedAt: "dispatch" };
        },
      },
      classifier: ctx => ({ intent: "billing", reasoning: "test" }),
      route: ctx => {
        captured.route = ctx.classifier?.intent;

        if (ctx.iteration === 1) return "capture";

        return END;
      },
      evaluate: ctx => {
        captured.evaluate = ctx.classifier?.intent;

        return undefined;
      },
    });

    await supervisorInstance.execute("hi");

    // Classifier picked "billing" on iter 0, then route fired iter 1
    // routing to capture, then END on iter 2. ctx.classifier visible
    // on every downstream context after iter 0.
    expect(captured.route).toBe("billing");
    expect(captured.dispatch).toBe("billing");
    expect(captured.evaluate).toBe("billing");
  });

  it("classifier picking unknown intent surfaces SupervisorFailedError on result.error", async () => {
    const billing = buildScriptedAgent({
      name: "billing",
      description: "billing",
      responses: [{ content: "x", finishReason: "stop" }],
    });

    const classifyAgent = buildClassifierAgent("classify", { intent: "unknown-intent" });

    const supervisorInstance = supervisor({
      name: "classifier-unknown-intent",
      intents: { billing },
      classifier: { agent: classifyAgent },
    });

    const result = await supervisorInstance.execute("input");

    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe("SUPERVISOR_INVALID_ROUTE");
    expect(result.report.classifier?.error).toBeDefined();
  });
});
